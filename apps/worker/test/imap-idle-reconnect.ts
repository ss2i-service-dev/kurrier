// Synchro temps reel IMAP en conditions reelles (OI 10346) : vrai ImapFlow, vrai initSmtpClient et
// vraies minuteries, contre un petit serveur IMAP local qu'on coupe puis qu'on redemarre. Verifie
// qu'apres un redemarrage du serveur plus long que la premiere tentative de reconnexion, l'IDLE
// repart seul (la seconde tentative aboutit), sur une seule connexion (safeReconnect n'en ouvre
// pas une seconde en parallele), et que rien ne se reconnecte apres stopRealtimeForIdentity.
// Puis, avec des delais de reconnexion divises par 100 : un mot de passe refuse
// (NO [AUTHENTICATIONFAILED]) ne fait pas retenter le LOGIN sans fin (Stalwart bannit l'IP source
// apres 100 echecs par jour, toutes boites confondues) ; une connexion reussie de l'identite leve
// la suspension, comme un imap:start-idle explicite ; une RST du serveur pendant le LOGOUT de
// stopRealtimeForIdentity ne laisse pas d'erreur non geree. Enfin (revue du lot) : un refus
// passager au LOGIN ([CONTACTADMIN] de Stalwart qui redemarre, [LIMIT]) ne suspend pas
// l'identite ; la suspension pour mot de passe refuse dure 6 h, apres quoi le balayage retente
// un seul LOGIN ; une coupure pendant le LOGIN ne laisse pas d'erreur non geree ; deux ouvertures
// simultanees du client d'une identite n'ouvrent qu'une connexion.
// Dure environ 55 s. Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55460/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/imap-idle-reconnect.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { createSecretAdmin, db, identities, smtpAccounts, smtpAccountSecrets } from "@db";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import net from "node:net";
import type { ImapFlow } from "imapflow";
import {
	realtimeDeps,
	recoverOfflineRealtime,
	startRealtimeForIdentity,
	stopRealtimeForIdentity,
} from "../lib/imap/imap-idle-sync";
import * as imapClient from "../lib/imap/imap-client";

const { imapAuthSuspended, initSmtpClient } = imapClient;
// Horloge des echecs d'authentification (absente avant la revue du lot : lue sans l'importer
// nommement pour que le test reste executable).
const imapClientDeps = (imapClient as any).imapClientDeps as { now: () => number } | undefined;

const uncaught: unknown[] = [];
process.on("uncaughtException", (err) => {
	console.error("UNCAUGHT", err);
	uncaught.push(err);
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Serveur IMAP minimal : ce qu'ImapFlow demande pour se connecter, ouvrir INBOX et rester en IDLE.
class FakeImapServer {
	sockets = new Set<net.Socket>();
	connections = 0;
	idles = 0;
	logins = 0;
	refuseLogin = false; // mot de passe refuse
	loginReply = "NO [AUTHENTICATIONFAILED] Authentication failed."; // reponse au LOGIN refuse
	dropOnLogin = false; // coupure pendant le LOGIN
	resetOnLogout = false; // RST au lieu de repondre au LOGOUT
	private server?: net.Server;
	constructor(readonly port: number) {}
	get live() {
		return [...this.sockets].filter((s) => !s.destroyed).length;
	}
	listen() {
		this.server = net.createServer((socket) => {
			this.connections++;
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});
			let buffer = "";
			let idleTag = "";
			const send = (line: string) => {
				if (!socket.destroyed) socket.write(`${line}\r\n`);
			};
			send("* OK fake IMAP ready");
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let nl: number;
				while ((nl = buffer.indexOf("\r\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 2);
					if (line.toUpperCase() === "DONE" && idleTag) {
						send(`${idleTag} OK IDLE terminated`);
						idleTag = "";
						continue;
					}
					const [tag, rawCmd] = line.split(" ");
					const cmd = (rawCmd ?? "").toUpperCase();
					if (cmd === "CAPABILITY") {
						send("* CAPABILITY IMAP4rev1 IDLE");
						send(`${tag} OK CAPABILITY completed`);
					} else if (cmd === "LOGIN") {
						this.logins++;
						if (this.dropOnLogin) socket.destroy();
						else if (this.refuseLogin) send(`${tag} ${this.loginReply}`);
						else send(`${tag} OK LOGIN completed`);
					} else if (cmd === "LIST") {
						send('* LIST (\\HasNoChildren) "/" INBOX');
						send(`${tag} OK LIST completed`);
					} else if (cmd === "SELECT" || cmd === "EXAMINE") {
						send("* FLAGS (\\Seen \\Flagged \\Answered \\Deleted \\Draft)");
						send("* 0 EXISTS");
						send("* OK [UIDVALIDITY 1] UIDs valid");
						send("* OK [UIDNEXT 1] Predicted next UID");
						send(`${tag} OK [READ-WRITE] SELECT completed`);
					} else if (cmd === "IDLE") {
						this.idles++;
						idleTag = tag;
						send("+ idling");
					} else if (cmd === "LOGOUT" && this.resetOnLogout) {
						socket.resetAndDestroy();
					} else if (cmd === "LOGOUT") {
						send("* BYE logging out");
						send(`${tag} OK LOGOUT completed`);
						socket.end();
					} else {
						send(`${tag} OK ${cmd || "command"} completed`);
					}
				}
			});
		});
		return new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
	}
	// Arret brutal (redemarrage du serveur, coupure reseau) : connexions detruites, port ferme.
	stop() {
		for (const s of this.sockets) s.destroy();
		return new Promise<void>((resolve) => this.server!.close(() => resolve()));
	}
}

const waitFor = async (cond: () => boolean, ms: number) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await sleep(100);
	}
	return cond();
};

const freePort = () =>
	new Promise<number>((resolve) => {
		const probe = net.createServer().listen(0, "127.0.0.1", () => {
			const p = (probe.address() as net.AddressInfo).port;
			probe.close(() => resolve(p));
		});
	});

// Identite dont le compte IMAP pointe sur le faux serveur local.
const imapIdentity = async (tag: string, port: number) => {
	const f = await createUserFixture(tag);
	const secret = await createSecretAdmin({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		name: "imap",
		value: JSON.stringify({
			IMAP_HOST: "127.0.0.1",
			IMAP_PORT: port,
			IMAP_SECURE: false,
			IMAP_USERNAME: "user",
			IMAP_PASSWORD: "pass",
		}),
	});
	const [account] = await db
		.insert(smtpAccounts)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id })
		.returning();
	await db
		.insert(smtpAccountSecrets)
		.values({ accountId: account.id, secretId: secret.id, workspaceId: f.workspace.id });
	await db.update(identities).set({ smtpAccountId: account.id }).where(eq(identities.id, f.identity.id));
	return f.identity.id;
};

async function main() {
	const imap = new FakeImapServer(await freePort());
	await imap.listen();
	const f = { identity: { id: await imapIdentity("rt-reel", imap.port) } };

	// Le rattrapage (deltaFetch sur le client de commandes) ouvrirait une seconde connexion : compte
	// a part, pour que le serveur ne voie que le client IDLE.
	let catchUps = 0;
	realtimeDeps.deltaFetch = async () => {
		catchUps++;
	};

	const idleMap = new Map<string, ImapFlow>();
	const cmdMap = new Map<string, ImapFlow>();
	await startRealtimeForIdentity(f.identity.id, idleMap, cmdMap);
	assert(await waitFor(() => imap.idles === 1, 5000), "IDLE en cours sur le serveur");
	assert(imap.live === 1, `une seule connexion au depart (${imap.live})`);

	// Redemarrage du serveur qui dure 8 s : la tentative a 5 s echoue, celle a 15 s doit aboutir.
	await imap.stop();
	const connectionsBefore = imap.connections;
	await sleep(8000);
	await imap.listen();
	assert(await waitFor(() => imap.idles === 2, 12000), "l'IDLE repart seul apres un echec de reconnexion");
	await sleep(6000); // au-dela du premier delai de safeReconnect (5 s)
	assert(
		imap.connections - connectionsBefore === 1 && imap.live === 1,
		`une seule connexion rouverte (${imap.connections - connectionsBefore} ouvertes, ${imap.live} vivantes)`,
	);

	assert(catchUps === 2, `rattrapage au demarrage puis apres la reprise (${catchUps})`);

	await stopRealtimeForIdentity(f.identity.id, idleMap, cmdMap);
	const afterStop = imap.connections;
	await sleep(7000);
	assert(imap.connections === afterStop && imap.live === 0, "plus de reconnexion apres stop");
	await imap.stop();

	// Mot de passe refuse. Les identites laissees par d'autres tests dans la base sont arretees pour
	// que le balayage ne vise que celle-ci ; reconnexions programmees divisees par 100.
	const authImap = new FakeImapServer(await freePort());
	authImap.refuseLogin = true;
	await authImap.listen();
	const authId = await imapIdentity("rt-auth", authImap.port);
	const others = await db
		.select({ id: identities.id })
		.from(identities)
		.where(and(isNotNull(identities.smtpAccountId), ne(identities.id, authId)));
	for (const row of others) await stopRealtimeForIdentity(row.id, new Map(), new Map());
	realtimeDeps.setTimeout = (fn, ms) => setTimeout(fn, ms / 100);

	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000); // 5 + 10 + 20 + 40 + 80 s divises par 100
	for (let i = 0; i < 3; i++) {
		await recoverOfflineRealtime(idleMap, cmdMap); // trois balayages : 30 min en production
		await sleep(300);
	}
	assert(authImap.logins <= 3, `mot de passe refuse : 3 LOGIN au plus, balayages compris (${authImap.logins})`);
	assert(authImap.live === 0, `connexions refusees refermees (${authImap.live} encore ouvertes)`);

	// Mot de passe corrige : le balayage ne retente pas seul ; une connexion reussie de l'identite
	// (action de l'utilisateur sur le client de commandes) leve la suspension.
	authImap.refuseLogin = false;
	const loginsSuspended = authImap.logins;
	await recoverOfflineRealtime(idleMap, cmdMap);
	await sleep(300);
	assert(authImap.logins === loginsSuspended, `suspendu : le balayage ne retente pas (${authImap.logins - loginsSuspended})`);
	const cmd = await initSmtpClient(authId, cmdMap);
	assert(cmd?.authenticated, "connexion de commandes reussie");
	await recoverOfflineRealtime(idleMap, cmdMap);
	assert(await waitFor(() => authImap.idles === 1, 3000), "apres une connexion reussie, le balayage relance l'IDLE");

	// RST pendant le LOGOUT de stopRealtimeForIdentity (clients IDLE et de commandes).
	authImap.resetOnLogout = true;
	await stopRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(300);
	assert(uncaught.length === 0, `RST pendant le LOGOUT : pas d'erreur non geree (${uncaught.length})`);
	authImap.resetOnLogout = false;

	// imap:start-idle explicite apres une suspension : l'identite repart.
	authImap.refuseLogin = true;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000);
	authImap.refuseLogin = false;
	const idlesBefore = authImap.idles;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	assert(await waitFor(() => authImap.idles === idlesBefore + 1, 3000), "un imap:start-idle explicite leve la suspension");
	await stopRealtimeForIdentity(authId, idleMap, cmdMap);

	// Refus passager au LOGIN : ImapFlow pose authenticationFailed sur tout NO ou BAD du LOGIN.
	// Stalwart repond [CONTACTADMIN] tant que son stockage ne repond pas (redemarrage), [LIMIT]
	// au-dela des connexions simultanees du compte : ni l'un ni l'autre ne suspend l'identite.
	authImap.refuseLogin = true;
	authImap.loginReply = "NO [CONTACTADMIN] Database failure.";
	let loginsBefore = authImap.logins;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000);
	assert(
		authImap.logins - loginsBefore === 6 && !imapAuthSuspended(authId),
		`refus passager ([CONTACTADMIN]) : reconnexions jusqu'au plafond, sans suspension (${authImap.logins - loginsBefore} LOGIN)`,
	);
	authImap.loginReply = "NO [LIMIT] Too many connections";
	loginsBefore = authImap.logins;
	for (let i = 0; i < 2; i++) {
		await recoverOfflineRealtime(idleMap, cmdMap);
		await sleep(300);
	}
	assert(authImap.logins - loginsBefore === 2, `refus passager ([LIMIT]) : chaque balayage retente (${authImap.logins - loginsBefore})`);
	authImap.refuseLogin = false;
	const idlesTransient = authImap.idles;
	await recoverOfflineRealtime(idleMap, cmdMap);
	assert(await waitFor(() => authImap.idles === idlesTransient + 1, 3000), "refus passager leve : le balayage relance l'IDLE");
	await stopRealtimeForIdentity(authId, idleMap, cmdMap);

	// Mot de passe refuse : suspension de 6 h (horloge des echecs avancee), puis un seul LOGIN par
	// balayage echu, soit au plus 3 + 4 echecs par jour et par identite.
	authImap.refuseLogin = true;
	authImap.loginReply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
	let shiftMs = 0;
	if (imapClientDeps) imapClientDeps.now = () => Date.now() + shiftMs;
	loginsBefore = authImap.logins;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000);
	assert(authImap.logins - loginsBefore === 3 && imapAuthSuspended(authId), `mot de passe refuse : suspendu apres 3 LOGIN (${authImap.logins - loginsBefore})`);
	const sweepLogins = async (shift: number) => {
		shiftMs = shift;
		const before = authImap.logins;
		await recoverOfflineRealtime(idleMap, cmdMap);
		await sleep(300);
		return authImap.logins - before;
	};
	const hour = 60 * 60 * 1000;
	const early = await sweepLogins(6 * hour - 60_000);
	assert(early === 0, `suspendu : pas de LOGIN avant 6 h (${early})`);
	const due = await sweepLogins(6 * hour);
	const again = await sweepLogins(6 * hour + 10 * 60_000);
	assert(due === 1 && again === 0, `apres 6 h, le balayage retente un seul LOGIN puis suspend de nouveau (${due}, puis ${again})`);
	const nextDue = await sweepLogins(12 * hour + 60_000);
	assert(nextDue === 1, `6 h plus tard, un LOGIN de nouveau (${nextDue})`);
	shiftMs = 0;
	if (imapClientDeps) imapClientDeps.now = () => Date.now();

	// Coupure pendant le LOGIN : ImapFlow emet 'error' avant que initSmtpClient ait pose ses
	// ecouteurs (Connection not available), en plus du rejet de connect().
	authImap.refuseLogin = false;
	authImap.dropOnLogin = true;
	const uncaughtBefore = uncaught.length;
	const dropped = await initSmtpClient(authId, new Map(), { reconnect: false });
	await sleep(300);
	assert(
		dropped === undefined && uncaught.length === uncaughtBefore,
		`coupure pendant le LOGIN : pas d'erreur non geree (${uncaught.length - uncaughtBefore})`,
	);
	authImap.dropOnLogin = false;

	// Deux ouvertures simultanees du client de commandes (rattrapage de l'IDLE et job de la file) :
	// une seule connexion, le meme client pour les deux.
	const sharedMap = new Map<string, ImapFlow>();
	const connectionsBeforeShared = authImap.connections;
	const [first, second] = await Promise.all([
		initSmtpClient(authId, sharedMap, { reconnect: false }),
		initSmtpClient(authId, sharedMap, { reconnect: false }),
	]);
	assert(
		first?.authenticated && first === second && authImap.connections - connectionsBeforeShared === 1,
		`ouvertures simultanees : une seule connexion (${authImap.connections - connectionsBeforeShared})`,
	);
	for (const c of new Set([first, second])) {
		c?.removeAllListeners();
		c?.on("error", () => {});
		await c?.logout().catch(() => {});
	}
	await authImap.stop();
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
