// Real-world IMAP realtime sync: real ImapFlow, real initSmtpClient and
// real timers, against a small local IMAP server that we stop and restart. Verifies
// that after a server restart longer than the first reconnect attempt, IDLE
// restarts on its own (the second attempt succeeds), on a single connection (safeReconnect does not open a second one in parallel), and that nothing reconnects after stopRealtimeForIdentity.
// Then, with reconnect delays divided by 100: a refused password
// (NO [AUTHENTICATIONFAILED]) does not retry LOGIN forever (Stalwart bans the source IP
// after 100 failures per day, across all mailboxes); a successful identity connection clears
// the suspension, like an explicit imap:start-idle; a server RST during LOGOUT of
// stopRealtimeForIdentity does not leave an unhandled error. Finally: a transient
// LOGIN refusal ([CONTACTADMIN] from Stalwart while restarting, [LIMIT]) does not suspend
// the identity; the refused-password suspension lasts 6 h, after which the sweep retries
// a single LOGIN; a disconnect during LOGIN does not leave an unhandled error; two simultaneous
// client openings for an identity open only one connection.
// Takes about 55 s. Test database: see mcp-test-env.ts:
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
// Authentication failure clock (absent before the batch review: read without importing it
// by name so that the test remains executable).
const imapClientDeps = (imapClient as any).imapClientDeps as { now: () => number } | undefined;

const uncaught: unknown[] = [];
process.on("uncaughtException", (err) => {
	console.error("UNCAUGHT", err);
	uncaught.push(err);
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Minimal IMAP server: what ImapFlow needs to connect, open INBOX, and remain in IDLE.
class FakeImapServer {
	sockets = new Set<net.Socket>();
	connections = 0;
	idles = 0;
	logins = 0;
	refuseLogin = false; // refused password
	loginReply = "NO [AUTHENTICATIONFAILED] Authentication failed."; // response to refused LOGIN
	dropOnLogin = false; // disconnect during LOGIN
	resetOnLogout = false; // RST instead of responding to LOGOUT
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
	// Abrupt stop (server restart, network disconnect): connections destroyed, port closed.
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

// Identity whose IMAP account points to the fake local server.
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

	// The catch-up (deltaFetch on the command client) would open a second connection: separate
	// it out so that the server sees only the IDLE client.
	let catchUps = 0;
	realtimeDeps.deltaFetch = async () => {
		catchUps++;
	};

	const idleMap = new Map<string, ImapFlow>();
	const cmdMap = new Map<string, ImapFlow>();
	await startRealtimeForIdentity(f.identity.id, idleMap, cmdMap);
	assert(await waitFor(() => imap.idles === 1, 5000), "IDLE active on the server");
	assert(imap.live === 1, `one connection at start (${imap.live})`);

	// Server restart lasting 8 s: the 5 s attempt fails, the 15 s attempt should succeed.
	await imap.stop();
	const connectionsBefore = imap.connections;
	await sleep(8000);
	await imap.listen();
	assert(await waitFor(() => imap.idles === 2, 12000), "IDLE restarts on its own after a reconnect failure");
	await sleep(6000); // beyond the first safeReconnect delay (5 s)
	assert(
		imap.connections - connectionsBefore === 1 && imap.live === 1,
		`only one connection reopened (${imap.connections - connectionsBefore} open, ${imap.live} live)`,
	);

	assert(catchUps === 2, `catch-up at startup and after recovery (${catchUps})`);

	await stopRealtimeForIdentity(f.identity.id, idleMap, cmdMap);
	const afterStop = imap.connections;
	await sleep(7000);
	assert(imap.connections === afterStop && imap.live === 0, "no reconnection after stop");
	await imap.stop();

	// Refused password. Identities left by other tests in the database are stopped so
	// that the sweep targets only this one; scheduled reconnects are divided by 100.
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
	await sleep(3000); // 5 + 10 + 20 + 40 + 80 s divided by 100
	for (let i = 0; i < 3; i++) {
		await recoverOfflineRealtime(idleMap, cmdMap); // three sweeps: 30 min in production
		await sleep(300);
	}
	assert(authImap.logins <= 3, `refused password: at most 3 LOGIN attempts, including sweeps (${authImap.logins})`);
	assert(authImap.live === 0, `refused connections closed (${authImap.live} still open)`);

	// Password corrected: the sweep does not retry on its own; a successful identity connection
	// (user action on the command client) clears the suspension.
	authImap.refuseLogin = false;
	const loginsSuspended = authImap.logins;
	await recoverOfflineRealtime(idleMap, cmdMap);
	await sleep(300);
	assert(authImap.logins === loginsSuspended, `suspended: sweep does not retry (${authImap.logins - loginsSuspended})`);
	const cmd = await initSmtpClient(authId, cmdMap);
	assert(cmd?.authenticated, "command connection succeeded");
	await recoverOfflineRealtime(idleMap, cmdMap);
	assert(await waitFor(() => authImap.idles === 1, 3000), "after a successful connection, the sweep restarts IDLE");

	// RST during LOGOUT of stopRealtimeForIdentity (IDLE and command clients).
	authImap.resetOnLogout = true;
	await stopRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(300);
	assert(uncaught.length === 0, `RST during LOGOUT: no unhandled error (${uncaught.length})`);
	authImap.resetOnLogout = false;

	// Explicit imap:start-idle after a suspension: the identity restarts.
	authImap.refuseLogin = true;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000);
	authImap.refuseLogin = false;
	const idlesBefore = authImap.idles;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	assert(await waitFor(() => authImap.idles === idlesBefore + 1, 3000), "explicit imap:start-idle clears the suspension");
	await stopRealtimeForIdentity(authId, idleMap, cmdMap);

	// Transient LOGIN refusal: ImapFlow sets authenticationFailed on any NO or BAD from LOGIN.
	// Stalwart responds [CONTACTADMIN] while its storage is unavailable (restart), [LIMIT]
	// beyond the account's simultaneous connections: neither suspends the identity.
	authImap.refuseLogin = true;
	authImap.loginReply = "NO [CONTACTADMIN] Database failure.";
	let loginsBefore = authImap.logins;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000);
	assert(
		authImap.logins - loginsBefore === 6 && !imapAuthSuspended(authId),
		`transient refusal ([CONTACTADMIN]): reconnects up to the cap, without suspension (${authImap.logins - loginsBefore} LOGIN attempts)`,
	);
	authImap.loginReply = "NO [LIMIT] Too many connections";
	loginsBefore = authImap.logins;
	for (let i = 0; i < 2; i++) {
		await recoverOfflineRealtime(idleMap, cmdMap);
		await sleep(300);
	}
	assert(authImap.logins - loginsBefore === 2, `transient refusal ([LIMIT]): each sweep retries (${authImap.logins - loginsBefore})`);
	authImap.refuseLogin = false;
	const idlesTransient = authImap.idles;
	await recoverOfflineRealtime(idleMap, cmdMap);
	assert(await waitFor(() => authImap.idles === idlesTransient + 1, 3000), "transient refusal cleared: sweep restarts IDLE");
	await stopRealtimeForIdentity(authId, idleMap, cmdMap);

	// Refused password: 6 h suspension (advanced failure clock), then one LOGIN per expired
	// sweep, at most 3 + 4 failures per day and per identity.
	authImap.refuseLogin = true;
	authImap.loginReply = "NO [AUTHENTICATIONFAILED] Authentication failed.";
	let shiftMs = 0;
	if (imapClientDeps) imapClientDeps.now = () => Date.now() + shiftMs;
	loginsBefore = authImap.logins;
	await startRealtimeForIdentity(authId, idleMap, cmdMap);
	await sleep(3000);
	assert(authImap.logins - loginsBefore === 3 && imapAuthSuspended(authId), `refused password: suspended after 3 LOGIN attempts (${authImap.logins - loginsBefore})`);
	const sweepLogins = async (shift: number) => {
		shiftMs = shift;
		const before = authImap.logins;
		await recoverOfflineRealtime(idleMap, cmdMap);
		await sleep(300);
		return authImap.logins - before;
	};
	const hour = 60 * 60 * 1000;
	const early = await sweepLogins(6 * hour - 60_000);
	assert(early === 0, `suspended: no LOGIN before 6 h (${early})`);
	const due = await sweepLogins(6 * hour);
	const again = await sweepLogins(6 * hour + 10 * 60_000);
	assert(due === 1 && again === 0, `after 6 h, sweep retries one LOGIN then suspends again (${due}, then ${again})`);
	const nextDue = await sweepLogins(12 * hour + 60_000);
	assert(nextDue === 1, `6 h later, one LOGIN again (${nextDue})`);
	shiftMs = 0;
	if (imapClientDeps) imapClientDeps.now = () => Date.now();

	// Disconnect during LOGIN: ImapFlow emits 'error' before initSmtpClient has attached its
	// listeners (Connection not available), in addition to connect() rejecting.
	authImap.refuseLogin = false;
	authImap.dropOnLogin = true;
	const uncaughtBefore = uncaught.length;
	const dropped = await initSmtpClient(authId, new Map(), { reconnect: false });
	await sleep(300);
	assert(
		dropped === undefined && uncaught.length === uncaughtBefore,
		`disconnect during LOGIN: no unhandled error (${uncaught.length - uncaughtBefore})`,
	);
	authImap.dropOnLogin = false;

	// Two simultaneous command client openings (IDLE catch-up and queue job):
	// one connection, the same client for both.
	const sharedMap = new Map<string, ImapFlow>();
	const connectionsBeforeShared = authImap.connections;
	const [first, second] = await Promise.all([
		initSmtpClient(authId, sharedMap, { reconnect: false }),
		initSmtpClient(authId, sharedMap, { reconnect: false }),
	]);
	assert(
		first?.authenticated && first === second && authImap.connections - connectionsBeforeShared === 1,
		`simultaneous openings: one connection (${authImap.connections - connectionsBeforeShared})`,
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
