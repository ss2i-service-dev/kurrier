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
// Au-dela de MAX_AUTH_FAILURES, plus aucun client de l'identite (IDLE, commandes, rattrapage,
// safeReconnect) ne tente de LOGIN pendant AUTH_SUSPENSION_MS depuis le dernier echec, sauf apres
// un imap:start-idle explicite (changement de mot de passe) ; a l'echeance, la premiere
// ouverture retente un LOGIN (en pratique le balayage), soit au plus 3 + 4 echecs par jour et
// par identite. Une suspension sans fin coupait sans bruit la synchro d'une
// boite que personne n'ouvre. Un autre echec (serveur injoignable, coupure, refus passager)
// interrompt la serie.
const MAX_AUTH_FAILURES = 3;
const AUTH_SUSPENSION_MS = 6 * 60 * 60 * 1000;
const authFailures = new Map<string, { count: number; at: number }>();

// ss2i (OI 10346) : horloge des echecs d'authentification, remplacee par imap-idle-reconnect.ts.
export const imapClientDeps = {
	now: () => Date.now(),
};

// ss2i (OI 10346) : ImapFlow pose authenticationFailed sur tout NO ou BAD au LOGIN
// (commands/login.js, authenticate.js), refus passagers compris : Stalwart repond [CONTACTADMIN]
// tant que son stockage ne repond pas, [LIMIT] au-dela des connexions simultanees du compte. Ne
// comptent que les refus des identifiants : NO sans code (Microsoft 365) ou a code d'identifiants
// de la RFC 5530 ([AUTHENTICATIONFAILED] de Stalwart et Gmail pour un mot de passe faux).
const CREDENTIAL_RESPONSE_CODES = new Set([
	"AUTHENTICATIONFAILED",
	"AUTHORIZATIONFAILED",
	"EXPIRED",
]);

const isCredentialRefusal = (err: unknown) => {
	const e = err as {
		authenticationFailed?: boolean;
		responseStatus?: string;
		serverResponseCode?: string;
	} | null;
	return (
		e?.authenticationFailed === true &&
		e.responseStatus === "NO" &&
		(!e.serverResponseCode || CREDENTIAL_RESPONSE_CODES.has(e.serverResponseCode))
	);
};

export const imapAuthSuspended = (identityId: string) => {
	const failures = authFailures.get(identityId);
	return (
		!!failures &&
		failures.count >= MAX_AUTH_FAILURES &&
		imapClientDeps.now() - failures.at < AUTH_SUSPENSION_MS
	);
};

export const resetImapAuthFailures = (identityId: string) => {
	authFailures.delete(identityId);
};

// ss2i (OI 10346, repris de pendingConnections de 5707ed41 amont) : ouverture en cours, par table
// de clients et par identite. Le rattrapage de l'IDLE (deltaFetch, hors de la file BullMQ), les
// jobs et safeReconnect pouvaient ouvrir en meme temps deux clients de commandes : le second
// restait ouvert et, a sa fermeture, son safeReconnect deconnectait le client actif.
const pendingConnections = new WeakMap<
	Map<string, ImapFlow>,
	Map<string, Promise<ImapFlow | undefined>>
>();

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

export const initSmtpClient = (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
	// ss2i (OI 10346) : false pour le client IDLE, que imap-idle-sync.ts reconnecte lui-meme
	// (scheduleReconnect, balayage imap:realtime-recovery) ; safeReconnect en rouvrait un second en
	// parallele, sans IDLE, qui pouvait prendre la place du bon dans la table.
	{ reconnect = true }: { reconnect?: boolean } = {},
): Promise<ImapFlow | undefined> => {
	const existing = imapInstances.get(identityId);
	if (existing?.authenticated && existing?.usable) {
		return Promise.resolve(existing);
	}

	let pending = pendingConnections.get(imapInstances);
	if (!pending) {
		pending = new Map();
		pendingConnections.set(imapInstances, pending);
	}

	const current = pending.get(identityId);
	if (current) {
		return current;
	}

	const connection = openImapClient(identityId, imapInstances, reconnect);
	pending.set(identityId, connection);
	void connection
		.finally(() => {
			if (pending.get(identityId) === connection) {
				pending.delete(identityId);
			}
		})
		.catch(() => {});

	return connection;
};

const openImapClient = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
	reconnect: boolean,
): Promise<ImapFlow | undefined> => {
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

	// ss2i (OI 10346) : mot de passe refuse, aucun LOGIN de plus, quel que soit le client (IDLE,
	// commandes, rattrapage, safeReconnect, jobs de la file) : le plafond ne valait que pour
	// l'IDLE et les autres clients refaisaient ~30 echecs par jour et par identite (Stalwart
	// bannit l'IP source a 100). Echec immediat, sans compter un nouvel echec ni programmer de
	// reconnexion ; les appelants traitent l'absence de client comme une connexion qui a echoue.
	// La suspension prend fin a l'echeance de 6 h ou par imap:start-idle (reinitialisation
	// avant l'ouverture, startRealtimeForIdentity).
	if (imapAuthSuspended(identityId)) {
		console.warn(
			`[IMAP:${identityId}] LOGIN skipped: authentication refused, suspended until the ` +
			"6 h deadline or imap:start-idle",
		);
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

		// ss2i (OI 10346) : une coupure pendant le LOGIN fait emettre 'error' (Connection not
		// available) avant que les ecouteurs ci-dessous soient poses : uncaughtException. Le rejet
		// de connect() suffit a traiter l'echec ; l'ecouteur reste sur un client refuse.
		const ignoreConnectError = () => {};
		client.on("error", ignoreConnectError);

		try {
			await client.connect();
			client.off("error", ignoreConnectError);
			retryCounts.set(identityId, 0);
			authFailures.delete(identityId);
		} catch (err) {
			console.error(`[IMAP:${identityId}] connect() failed:`, err);
			if (isCredentialRefusal(err)) {
				authFailures.set(identityId, {
					count: (authFailures.get(identityId)?.count ?? 0) + 1,
					at: imapClientDeps.now(),
				});
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
