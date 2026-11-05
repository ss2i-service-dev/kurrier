// IMAP real-time sync lifecycle (lib/imap/imap-idle-sync.ts), with a fake
// ImapFlow and a simulated clock (realtimeDeps). Checks: (a) a reconnect failure schedules
// a retry (5, 10, 20, 40, 80 s) up to the limit; (b) the imap:realtime-recovery
// scan restarts a dead client, ignores healthy ones, those whose reconnect is already scheduled, and those
// that were stopped; (c) an idle() that returns immediately does not loop; (d) no more
// reconnects after stopRealtimeForIdentity; (e) never two IDLE clients for one identity;
// (f) a deltaFetch or database error on exists, flags, and expunge leaves no unhandled
// rejected promise; (g) no more reconnects once worker shutdown starts; (h) every
// established IDLE (startup, reconnect) catches up with deltaFetch on messages received during the
// outage (ImapFlow does not emit exists on SELECT); (i) a server that accepts the connection then
// immediately disconnects does not reconnect forever (the counter resets only after a
// connection that held).
// Test database: see mcp-test-env.ts:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55460/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/imap-idle-lifecycle.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, identities, smtpAccounts } from "@db";
import { eq } from "drizzle-orm";
import { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
import * as realtime from "../lib/imap/imap-idle-sync";
import { deltaFetch } from "../lib/imap/imap-delta-fetch";

const { realtimeDeps, startRealtimeForIdentity, stopRealtimeForIdentity } = realtime;
// Not present in older versions: read without named imports so the test remains executable.
const recoverOfflineRealtime = (realtime as any).recoverOfflineRealtime as
	| ((idle: Map<string, ImapFlow>, cmd: Map<string, ImapFlow>) => Promise<void>)
	| undefined;
const beginRealtimeShutdown = (realtime as any).beginRealtimeShutdown as (() => void) | undefined;

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
	unhandled.push(reason);
});

// Let the database and promises settle (real time, not the simulated clock).
const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const noConnection = () => Object.assign(new Error("Connection not available"), { code: "NoConnection" });

class FakeIdle extends EventEmitter {
	authenticated = true;
	usable = true;
	idling = false;
	idleCalls = 0;
	immediate = false; // idle() returns immediately, like ImapFlow already in IDLE
	flap = false; // the server disconnects as soon as IDLE starts
	private stopIdle?: (err?: Error) => void;
	async getMailboxLock(path: string) {
		return { path, release() {} };
	}
	idle(): Promise<unknown> {
		this.idleCalls++;
		// Safeguard: a loop without a pause must not block the test.
		if (this.idleCalls > 1000) this.drop();
		if (!this.usable) return Promise.reject(noConnection());
		if (this.flap) {
			this.drop();
			return Promise.reject(noConnection());
		}
		if (this.immediate) return Promise.resolve(false);
		this.idling = true;
		return new Promise((resolve, reject) => {
			this.stopIdle = (err) => {
				this.idling = false;
				if (err) reject(err);
				else resolve(true);
			};
		});
	}
	// Network disconnect or server restart: like ImapFlow.close(), the current command is
	// rejected and "close" is emitted.
	drop() {
		if (!this.usable) return;
		this.usable = false;
		this.authenticated = false;
		this.stopIdle?.(noConnection());
		this.emit("close");
	}
	close() {
		this.drop();
	}
	async logout() {
		this.drop();
	}
	async fetchOne() {
		return { uid: 1 };
	}
	async noop() {}
}

class Clock {
	now = 0;
	private seq = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	setTimeout = (fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.now + ms, fn });
		return id;
	};
	clearTimeout = (id: unknown) => {
		this.timers.delete(id as number);
	};
	// Trigger expired timers one by one, letting the database respond between them.
	async advance(ms: number) {
		const end = this.now + ms;
		for (;;) {
			const next = [...this.timers.entries()]
				.filter(([, t]) => t.at <= end)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.timers.delete(next[0]);
			this.now = next[1].at;
			next[1].fn();
			await settle();
		}
		this.now = end;
		await settle();
	}
}

const clock = new Clock();
const known = new Set<string>(); // identities whose fake server accepts the connection
const refused = new Set<string>(); // server unreachable for these identities
const immediateIdle = new Set<string>(); // identities whose idle() returns immediately
const flapping = new Set<string>(); // server that disconnects every connection as soon as IDLE starts
const catchUps = new Map<string, number[]>(); // times of deltaFetch calls (catch-up, exists)
const attempts = new Map<string, number[]>(); // times (simulated clock) of attempted openings
const opened = new Map<string, FakeIdle[]>();
let openDelayMs = 0;

realtimeDeps.setTimeout = clock.setTimeout;
realtimeDeps.clearTimeout = clock.clearTimeout;
realtimeDeps.now = () => clock.now;
// deltaFetch on the command client: count calls; use the real one for identity (f), whose
// database rejects the identifier, to verify that no rejected promise remains unhandled.
realtimeDeps.deltaFetch = async (identityId: string, cmd: Map<string, ImapFlow>) => {
	catchUps.set(identityId, [...(catchUps.get(identityId) ?? []), clock.now]);
	if (identityId === "rt-f-not-a-uuid") await deltaFetch(identityId, cmd);
};
realtimeDeps.openClient = async (identityId: string, map: Map<string, ImapFlow>) => {
	// Like initSmtpClient: use the client from the table if healthy, otherwise create a new connection.
	const existing = map.get(identityId) as unknown as FakeIdle | undefined;
	if (existing?.authenticated && existing?.usable) return existing as unknown as ImapFlow;
	if (existing) map.delete(identityId);
	attempts.set(identityId, [...(attempts.get(identityId) ?? []), clock.now]);
	if (openDelayMs) await settle(openDelayMs);
	if (!known.has(identityId) || refused.has(identityId)) return undefined;
	const client = new FakeIdle();
	client.immediate = immediateIdle.has(identityId);
	client.flap = flapping.has(identityId);
	opened.set(identityId, [...(opened.get(identityId) ?? []), client]);
	map.set(identityId, client as unknown as ImapFlow);
	return client as unknown as ImapFlow;
};

const idleMap = new Map<string, ImapFlow>();
const cmdMap = new Map<string, ImapFlow>();
const tries = (id: string) => attempts.get(id)?.length ?? 0;
const fetches = (id: string) => catchUps.get(id)?.length ?? 0;
const live = (id: string) => (opened.get(id) ?? []).filter((c) => c.usable && c.idling).length;
const last = (id: string) => (opened.get(id) ?? []).at(-1);
const start = (id: string) => startRealtimeForIdentity(id, idleMap, cmdMap);

async function main() {
	// (a) Disconnect then unreachable server: 5 attempts spaced by 5, 10, 20, 40, 80 s.
	known.add("rt-a");
	await start("rt-a");
	await settle();
	assert(live("rt-a") === 1, "(a) IDLE client opened");
	refused.add("rt-a");
	const t0 = clock.now;
	last("rt-a")!.drop();
	await settle();
	await clock.advance(10 * 60 * 1000);
	const gaps = (attempts.get("rt-a") ?? []).slice(1).map((t, i, all) => t - (i ? all[i - 1] : t0));
	assert(
		JSON.stringify(gaps) === JSON.stringify([5000, 10000, 20000, 40000, 80000]),
		`(a) a reconnect failure schedules a retry up to the limit (gaps ${JSON.stringify(gaps)})`,
	);
	await clock.advance(60 * 60 * 1000);
	assert(tries("rt-a") === 6, `(a) nothing else after the limit (${tries("rt-a")} openings)`);

	// (c) idle() that returns immediately: only one retry per second.
	known.add("rt-c");
	immediateIdle.add("rt-c");
	await start("rt-c");
	await settle();
	const callsBefore = last("rt-c")!.idleCalls;
	assert(callsBefore <= 2, `(c) an idle() that returns immediately does not loop (${callsBefore} calls)`);
	await clock.advance(1000);
	assert(last("rt-c")!.idleCalls <= callsBefore + 1, "(c) the loop resumes after a one-second pause");
	await stopRealtimeForIdentity("rt-c", idleMap, cmdMap);

	// (d) Stop an identity: no reconnect, neither on disconnect nor on an already scheduled timer.
	known.add("rt-d");
	await start("rt-d");
	await settle();
	await stopRealtimeForIdentity("rt-d", idleMap, cmdMap);
	await clock.advance(5 * 60 * 1000);
	assert(tries("rt-d") === 1 && live("rt-d") === 0, `(d) no more reconnects after stop (${tries("rt-d")} openings)`);
	known.add("rt-d2");
	await start("rt-d2");
	await settle();
	last("rt-d2")!.drop();
	await settle();
	await stopRealtimeForIdentity("rt-d2", idleMap, cmdMap);
	await clock.advance(5 * 60 * 1000);
	assert(tries("rt-d2") === 1, `(d) the already scheduled reconnect is canceled by stop (${tries("rt-d2")} openings)`);
	await start("rt-d");
	await settle();
	assert(live("rt-d") === 1, "(d) an explicit start after stop restarts the identity");
	await stopRealtimeForIdentity("rt-d", idleMap, cmdMap);

	// (e) Concurrent starts (imap:start-idle job, startup sync, scan): one connection.
	known.add("rt-e");
	openDelayMs = 20;
	await Promise.all([start("rt-e"), start("rt-e"), start("rt-e")]);
	await settle(100);
	assert(
		(opened.get("rt-e") ?? []).length === 1 && live("rt-e") === 1,
		`(e) never two IDLE clients for one identity (${(opened.get("rt-e") ?? []).length} opened, ${live("rt-e")} in IDLE)`,
	);
	last("rt-e")!.drop();
	await settle();
	// Scheduled reconnect + explicit start + timer: still only one live client.
	await Promise.all([start("rt-e"), clock.advance(5000)]);
	await settle(100);
	await clock.advance(5 * 60 * 1000);
	assert(live("rt-e") === 1, `(e) one IDLE client after disconnect and concurrent restart (${live("rt-e")})`);
	openDelayMs = 0;
	await stopRealtimeForIdentity("rt-e", idleMap, cmdMap);

	// (f) Failing event handlers (identifier that is not a uuid: the database throws).
	const bad = "rt-f-not-a-uuid";
	known.add(bad);
	cmdMap.set(bad, new FakeIdle() as unknown as ImapFlow); // command client for deltaFetch
	await start(bad);
	await settle();
	const before = unhandled.length;
	const c = last(bad)!;
	c.emit("exists", { path: "INBOX", count: 2, prevCount: 1 });
	c.emit("flags", { path: "INBOX", seq: 1, uid: 7, flags: new Set(["\\Seen"]) });
	c.emit("expunge", { path: "INBOX", seq: 1, uid: 7 });
	await settle(300);
	assert(
		unhandled.length === before,
		`(f) failed exists, flags, and expunge leave no unhandled rejected promise (${unhandled.length - before})`,
	);
	await stopRealtimeForIdentity(bad, idleMap, cmdMap);

	// (b) imap:realtime-recovery scan on real identities (smtp_account_id set).
	const withAccount = async (tag: string) => {
		const f = await createUserFixture(tag);
		const [account] = await db
			.insert(smtpAccounts)
			.values({ ownerId: f.user.id, workspaceId: f.workspace.id })
			.returning();
		await db.update(identities).set({ smtpAccountId: account.id }).where(eq(identities.id, f.identity.id));
		known.add(f.identity.id);
		return f.identity.id;
	};
	const healthy = await withAccount("rt-sain");
	const dead = await withAccount("rt-mort");
	const waiting = await withAccount("rt-attente");
	await start(healthy);
	refused.add(dead);
	await start(dead);
	await settle();
	await clock.advance(10 * 60 * 1000); // limit reached for « dead »
	await start(waiting);
	await settle();
	refused.add(waiting);
	last(waiting)!.drop(); // reconnect scheduled in 5 s
	await settle();
	assert(typeof recoverOfflineRealtime === "function", "(b) recoverOfflineRealtime exported");
	if (recoverOfflineRealtime) {
		refused.delete(dead);
		const triesHealthy = tries(healthy);
		const triesWaiting = tries(waiting);
		await recoverOfflineRealtime(idleMap, cmdMap);
		await settle(100);
		assert(live(dead) === 1, "(b) the scan restarts a dead client after the limit");
		assert(tries(healthy) === triesHealthy && live(healthy) === 1, "(b) the scan ignores a healthy client");
		assert(tries(waiting) === triesWaiting, "(b) the scan lets an already scheduled reconnect proceed");
		await clock.advance(2 * 60 * 1000); // resumed connection holds for two minutes
		const t1 = clock.now;
		last(dead)!.drop();
		await settle();
		await clock.advance(5000);
		assert(
			(attempts.get(dead) ?? []).at(-1) === t1 + 5000 && live(dead) === 1,
			"(b) after a connection that held, reconnect starts again at 5 s",
		);
		await stopRealtimeForIdentity(healthy, idleMap, cmdMap);
		const triesStopped = tries(healthy);
		await recoverOfflineRealtime(idleMap, cmdMap);
		await settle(100);
		assert(tries(healthy) === triesStopped, "(b) the scan does not restart a stopped identity");
	}

	// (h) Catch-up: IDLE does not see what arrived during the outage, deltaFetch does.
	known.add("rt-h");
	await start("rt-h");
	await settle();
	assert(fetches("rt-h") === 1, `(h) one catch-up as soon as IDLE is established (${fetches("rt-h")})`);
	await clock.advance(60 * 1000);
	const tDrop = clock.now;
	last("rt-h")!.drop();
	await settle();
	await clock.advance(5000);
	assert(
		live("rt-h") === 1 && fetches("rt-h") === 2 && catchUps.get("rt-h")!.at(-1) === tDrop + 5000,
		`(h) a catch-up after reconnect (${fetches("rt-h")} calls)`,
	);
	await stopRealtimeForIdentity("rt-h", idleMap, cmdMap);

	// (i) Server that accepts the connection then disconnects immediately: no reconnect every 5 s.
	known.add("rt-i");
	flapping.add("rt-i");
	await start("rt-i");
	await settle();
	await clock.advance(30 * 60 * 1000);
	assert(tries("rt-i") <= 6, `(i) a server that disconnects immediately does not reconnect forever (${tries("rt-i")} openings in 30 min)`);
	await stopRealtimeForIdentity("rt-i", idleMap, cmdMap);

	// (g) Worker shutdown: the scheduled reconnect is canceled, no more starts.
	known.add("rt-g");
	known.add("rt-g2");
	await start("rt-g");
	await settle();
	last("rt-g")!.drop();
	await settle();
	assert(typeof beginRealtimeShutdown === "function", "(g) beginRealtimeShutdown exported");
	beginRealtimeShutdown?.();
	await clock.advance(10 * 60 * 1000);
	await start("rt-g2");
	await settle();
	assert(tries("rt-g") === 1 && tries("rt-g2") === 0, `(g) no more reconnects during shutdown (${tries("rt-g")}, ${tries("rt-g2")})`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
