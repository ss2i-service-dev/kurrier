// Synchro temps reel IMAP en conditions reelles (OI 10346) : vrai ImapFlow, vrai initSmtpClient et
// vraies minuteries, contre un petit serveur IMAP local qu'on coupe puis qu'on redemarre. Verifie
// qu'apres un redemarrage du serveur plus long que la premiere tentative de reconnexion, l'IDLE
// repart seul (la seconde tentative aboutit), sur une seule connexion (safeReconnect n'en ouvre
// pas une seconde en parallele), et que rien ne se reconnecte apres stopRealtimeForIdentity.
// Dure environ 35 s. Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55460/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/imap-idle-reconnect.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { createSecretAdmin, db, identities, smtpAccounts, smtpAccountSecrets } from "@db";
import { eq } from "drizzle-orm";
import net from "node:net";
import type { ImapFlow } from "imapflow";
import { startRealtimeForIdentity, stopRealtimeForIdentity } from "../lib/imap/imap-idle-sync";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Serveur IMAP minimal : ce qu'ImapFlow demande pour se connecter, ouvrir INBOX et rester en IDLE.
class FakeImapServer {
	sockets = new Set<net.Socket>();
	connections = 0;
	idles = 0;
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

async function main() {
	const port = await new Promise<number>((resolve) => {
		const probe = net.createServer().listen(0, "127.0.0.1", () => {
			const p = (probe.address() as net.AddressInfo).port;
			probe.close(() => resolve(p));
		});
	});
	const imap = new FakeImapServer(port);
	await imap.listen();

	const f = await createUserFixture("rt-reel");
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

	await stopRealtimeForIdentity(f.identity.id, idleMap, cmdMap);
	const afterStop = imap.connections;
	await sleep(7000);
	assert(imap.connections === afterStop && imap.live === 0, "plus de reconnexion apres stop");
	await imap.stop();
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
