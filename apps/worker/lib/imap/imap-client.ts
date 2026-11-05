import { db, decryptAdminSecrets, identities, smtpAccountSecrets } from "@db";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";

const retryCounts = new Map<string, number>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const MAX_RETRIES = 5;
const BASE_DELAY = 5000;

// ss2i (OI 10346, d'apres canAttemptImapConnection de 9b34ee91 amont) : echecs d'authentification
// consecutifs par identite, tous clients confondus. Stalwart bannit l'IP source apres 100 echecs
// d'authentification par jour, toutes boites confondues : un mot de passe refuse, retente a chaque
// balayage imap:realtime-recovery (144 fois par jour), aurait coupe l'IMAP de toutes les boites.
// Au-dela de MAX_AUTH_FAILURES, imap-idle-sync.ts suspend ses reconnexions automatiques jusqu'a une
// connexion reussie de l'identite ou un imap:start-idle explicite. Un autre echec (serveur
// injoignable, coupure) interrompt la serie.
const MAX_AUTH_FAILURES = 3;
const authFailures = new Map<string, number>();

export const imapAuthSuspended = (identityId: string) =>
	(authFailures.get(identityId) ?? 0) >= MAX_AUTH_FAILURES;

export const resetImapAuthFailures = (identityId: string) => {
	authFailures.delete(identityId);
};

function safeReconnect(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) {
	const currentRetries = retryCounts.get(identityId) ?? 0;

	if (currentRetries >= MAX_RETRIES) {
		console.error(`[IMAP:${identityId}] Max retries reached. Cooling down.`);
		return;
	}

	const delay = BASE_DELAY * (currentRetries + 1);
	retryCounts.set(identityId, currentRetries + 1);

	const existing = imapInstances.get(identityId);
	if (existing) {
		try {
			existing.removeAllListeners();
			existing.logout().catch(() => {});
		} catch {}
		imapInstances.delete(identityId);
	}

	if (reconnectTimers.has(identityId)) {
		clearTimeout(reconnectTimers.get(identityId)!);
	}

	const timer = setTimeout(() => {
		reconnectTimers.delete(identityId);
		initSmtpClient(identityId, imapInstances).catch(console.error);
	}, delay);

	reconnectTimers.set(identityId, timer);
}

export const initSmtpClient = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
	// ss2i (OI 10346) : false pour le client IDLE, que imap-idle-sync.ts reconnecte lui-meme
	// (scheduleReconnect, balayage imap:realtime-recovery) ; safeReconnect en rouvrait un second en
	// parallele, sans IDLE, qui pouvait prendre la place du bon dans la table.
	{ reconnect = true }: { reconnect?: boolean } = {},
) => {
	const retry = () => {
		if (reconnect) safeReconnect(identityId, imapInstances);
	};

	try {
		const existing = imapInstances.get(identityId);
		if (existing && existing.authenticated && existing.usable) {
			return existing;
		}

		if (existing) {
			try {
				existing.removeAllListeners();
				existing.logout().catch(() => {});
			} catch {}
			imapInstances.delete(identityId);
		}
	} catch (err) {
		console.error(`[IMAP:${identityId}] Existing instance check failed`, err);
		retry();
		return;
	}

	try {
		const [identity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, identityId));

		if (!identity || !identity.smtpAccountId) {
			return;
		}

		const [secrets] = await decryptAdminSecrets({
			linkTable: smtpAccountSecrets,
			foreignCol: smtpAccountSecrets.accountId,
			secretIdCol: smtpAccountSecrets.secretId,
			ownerId: identity.ownerId,
			parentId: String(identity.smtpAccountId),
		});

		const credentials = secrets?.vault?.decrypted_secret
			? JSON.parse(secrets.vault.decrypted_secret)
			: {};

		const client = new ImapFlow({
			host: credentials.IMAP_HOST,
			port: credentials.IMAP_PORT,
			secure:
				credentials.IMAP_SECURE === "true" || credentials.IMAP_SECURE === true,
			auth: {
				user: credentials.IMAP_USERNAME,
				pass: credentials.IMAP_PASSWORD,
			},
			// ss2i : 5 min au lieu de 60 s. Gmail ralentit fortement le flux quand on approche de son
			// plafond quotidien ; a 60 s les lots du rattrapage etaient coupes en plein milieu.
			socketTimeout: 300_000,
			logger: {
				error(data: any) {
					console.error(`[IMAP:${identityId}]`, data.msg ?? data);
				},
				warn() {},
				info() {},
				debug() {},
			},
			logRaw: false,
		});

		try {
			await client.connect();
			retryCounts.set(identityId, 0);
			authFailures.delete(identityId);
		} catch (err) {
			console.error(`[IMAP:${identityId}] connect() failed:`, err);
			if ((err as { authenticationFailed?: boolean } | null)?.authenticationFailed) {
				authFailures.set(identityId, (authFailures.get(identityId) ?? 0) + 1);
			} else {
				authFailures.delete(identityId);
			}
			// ss2i (OI 10346) : apres un LOGIN refuse, ImapFlow garde la connexion ouverte jusqu'au
			// socketTimeout (5 min), puis emet une erreur que plus personne n'ecoute.
			try {
				client.close();
			} catch {}
			retry();
			return;
		}

		imapInstances.set(identityId, client);

		const noopInterval = setInterval(async () => {
			try {
				if (client.usable) {
					await client.noop();
				} else {
					throw new Error("Client not usable");
				}
			} catch (err) {
				clearInterval(noopInterval);
				// ss2i (OI 10346) : client IDLE deja ferme (arret, remplacement) : rien a faire.
				if (!reconnect && !client.usable) return;
				console.error(`[IMAP:${identityId}] NOOP failed:`, err);
				if (reconnect) safeReconnect(identityId, imapInstances);
				else client.close();
			}
		}, 5 * 60 * 1000);

		const cleanup = (reason: string) => {
			clearInterval(noopInterval);
			try {
				client.removeAllListeners();
				client.logout().catch(() => {});
			} catch {}
			// ss2i (OI 10346) : ne retirer que ce client, un plus recent a pu le remplacer.
			if (imapInstances.get(identityId) === client) imapInstances.delete(identityId);
			console.warn(`[IMAP:${identityId}] Disconnected (${reason})`);
			retry();
		};

		client.once("close", () => cleanup("close"));
		client.once("error", (err) => {
			console.error(`[IMAP:${identityId}] Error:`, err);
			cleanup("error");
		});

		return client;
	} catch (err) {
		console.error(`[IMAP:${identityId}] init failed`, err);
		retry();
		return;
	}
};
