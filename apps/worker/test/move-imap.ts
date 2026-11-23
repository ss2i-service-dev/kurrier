// moveMail end to end on a test database, with a fake IMAP server that behaves like
// Stalwart: permuted COPYUID, empty SEARCH HEADER Message-ID, no scan beyond 5,000
// messages, MOVE refused (false without an error) or partial. Checks: UIDs copied back by
// Message-ID (in slices), deltaFetch cursor of the destination folder (written once, after
// the MOVE, duplicates included), IMAP trash even when the page says "database only", key
// collisions (mailbox_threads, and messages: same Message-ID already at the destination)
// without losing the other threads, UID removed from the transaction on, database rollback
// of what the server did not move (including what was never sent), IMAP unavailable =
// nothing moves, batch of more than 65,534 arrived UIDs, and deltaFetch no longer deleting
// the copy in Sent. Gmail: a message already at the destination (absent from the source)
// takes its UID over by Message-ID, and a row without a UID is looked up by Message-ID
// instead of being moved in the database only. Messages whose meta is the JSON `null`: moved,
// or put back in place.
// Test database: see mcp-test-env.ts:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55436/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/move-imap.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { moveMail } from "../lib/imap/imap-move";
import { dueExpiredThreads } from "../lib/mail-expiry";
import { deltaFetch } from "../lib/imap/imap-delta-fetch";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;
type Folder = { uidNext: number; msgs: Map<number, string | null> };

class FakeStalwart {
	authenticated = true;
	usable = true;
	refuseMove = false;
	skipOnMove = new Set<number>(); // UIDs the server "forgets" while answering OK
	duplicateOnMove = new Set<number>(); // UIDs of which the server drops two copies at the destination
	vanishOnMove = new Set<number>(); // UIDs removed from the source without arriving anywhere
	flood = 0; // foreign messages arrived in the destination during the MOVE
	existsOverride: number | null = null; // "too big" folder: resolveUids does not scan
	onLock?: (path: string) => Promise<void>;
	onMove?: () => Promise<void>;
	flagged = new Set<string>(); // Message-ID carrying \Flagged (set from another client)
	moves = 0;
	selected = "";
	folders = new Map<string, Folder>();
	constructor(init: Record<string, { uidNext: number; msgs: Array<[number, string | null]> }>) {
		for (const [p, f] of Object.entries(init)) this.folders.set(p, { uidNext: f.uidNext, msgs: new Map(f.msgs) });
	}
	get mailbox() {
		const f = this.folders.get(this.selected);
		return f ? { path: this.selected, exists: this.existsOverride ?? f.msgs.size, uidNext: f.uidNext } : false;
	}
	async getMailboxLock(path: string) {
		if (!this.folders.has(path)) throw new Error(`no folder ${path}`);
		this.selected = path;
		if (this.onLock) await this.onLock(path);
		return { path, release() {} };
	}
	async mailboxOpen(path: string) {
		this.selected = path;
		return this.mailbox;
	}
	async status(path: string) {
		return { path, uidNext: this.folders.get(path)!.uidNext };
	}
	gmail = false; // X-GM-EXT-1: SEARCH HEADER Message-ID and X-GM-RAW "rfc822msgid:" both answer
	get capabilities() {
		return new Map(this.gmail ? [["X-GM-EXT-1", true]] : []);
	}
	async search(q: any = {}) {
		if (!this.gmail) return []; // Stalwart returns nothing on SEARCH HEADER Message-ID
		const norm = (v: unknown) => String(v ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
		const want = norm(q.header ? q.header["message-id"] : String(q.gmraw ?? "").replace(/^rfc822msgid:/, ""));
		return [...this.folders.get(this.selected)!.msgs].filter(([, m]) => norm(m) === want).map(([u]) => u);
	}
	async *fetch(range: string | { uid: string }) {
		const f = this.folders.get(this.selected)!;
		const all = [...f.msgs.keys()].sort((a, b) => a - b);
		const r = typeof range === "string" ? range : range.uid;
		let pick: number[];
		if (r.endsWith(":*")) {
			const a = Number(r.split(":")[0]);
			pick = all.filter((u) => u >= a);
			if (!pick.length && all.length) pick = [all[all.length - 1]];
		} else if (/^\d+:\d+$/.test(r)) {
			const [a, b] = r.split(":").map(Number);
			pick = all.filter((u) => u >= a && u <= b);
		} else {
			pick = r.split(",").map(Number).filter((u) => f.msgs.has(u));
		}
		for (const uid of pick) {
			const mid = f.msgs.get(uid);
			yield {
				uid,
				envelope: { messageId: mid ?? undefined },
				flags: new Set<string>(mid && this.flagged.has(mid) ? ["\\Seen", "\\Flagged"] : ["\\Seen"]),
				internalDate: new Date(),
				size: 10,
				source: Buffer.from(`Message-ID: ${mid}\r\nSubject: x\r\n\r\nbody`),
			};
		}
	}
	async messageMove(uids: number[], dest: string) {
		this.moves++;
		if (this.onMove) await this.onMove();
		if (this.refuseMove) return false;
		const s = this.folders.get(this.selected)!;
		const d = this.folders.get(dest)!;
		const present = uids.filter((u) => s.msgs.has(u) && !this.skipOnMove.has(u)).sort((a, b) => a - b);
		const destUids: number[] = [];
		for (const u of uids) if (this.vanishOnMove.has(u)) s.msgs.delete(u);
		for (const u of present) {
			if (this.vanishOnMove.has(u)) continue;
			const nu = d.uidNext++;
			d.msgs.set(nu, s.msgs.get(u)!);
			if (this.duplicateOnMove.has(u)) d.msgs.set(d.uidNext++, s.msgs.get(u)!);
			s.msgs.delete(u);
			destUids.push(nu);
		}
		for (let i = 0; i < this.flood; i++) d.msgs.set(d.uidNext++, `<flood-${i}@elsewhere.invalid>`);
		// COPYUID like Stalwart: the two sets do not match in order
		return { path: this.selected, destination: dest, uidMap: new Map(present.map((u, i) => [u, destUids[destUids.length - 1 - i]])) };
	}
}

async function trashOf(f: Fixture) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind: "trash",
			name: "Deleted Items",
			slug: "trash",
			isDefault: true,
			metaData: { imap: { path: "Deleted Items" } },
		})
		.returning();
	return row;
}

async function folderOf(f: Fixture, kind: "archive" | "spam" | "custom", name: string) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind,
			name,
			slug: kind === "custom" ? name.toLowerCase() : kind,
			isDefault: false,
			metaData: { imap: { path: name } },
		})
		.returning();
	return row;
}

const on = (f: Fixture, imap: FakeStalwart) => new Map([[f.identity.id, imap as unknown as ImapFlow]]);

async function syncRow(f: Fixture, mailboxId: string, lastSeenUid: number) {
	await db.insert(mailboxSync).values({ identityId: f.identity.id, mailboxId, uidValidity: BigInt(1), lastSeenUid });
}

async function cursorOf(mailboxId: string) {
	const [r] = await db.select().from(mailboxSync).where(eq(mailboxSync.mailboxId, mailboxId));
	return Number(r.lastSeenUid);
}

// A thread of messages in `mailboxId`; uid null = message without an IMAP UID.
async function thread(f: Fixture, mailboxId: string, items: Array<{ mid: string; uid: number | null; path?: string; nullMeta?: boolean }>) {
	const [t] = await db
		.insert(threads)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() })
		.returning();
	const ids: string[] = [];
	for (const [i, it] of items.entries()) {
		const [m] = await db
			.insert(messages)
			.values({
				ownerId: f.user.id,
				workspaceId: f.workspace.id,
				mailboxId,
				threadId: t.id,
				messageId: it.mid,
				subject: `thread ${it.mid}`,
				text: "corps",
				date: new Date(Date.now() - (items.length - i) * 60_000),
				seen: false,
				metaData: it.uid === null ? {} : { imap: { uid: it.uid, mailboxPath: it.path ?? "INBOX" } },
			} as any)
			.returning();
		ids.push(m.id);
		// JSON `null` (jsonb 'null'), not the SQL NULL: drizzle writes an SQL NULL for `null`.
		if (it.nullMeta) await db.execute(sql`update messages set meta = 'null'::jsonb where id = ${m.id}::uuid`);
	}
	await upsertMailboxThreadItem(ids[ids.length - 1]);
	return { id: t.id, ids };
}

// A thread of many messages, inserted in batches (consecutive UIDs from firstUid).
async function bigThread(f: Fixture, mailboxId: string, mids: string[], firstUid: number) {
	const [t] = await db
		.insert(threads)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() })
		.returning();
	const ids: string[] = [];
	for (let i = 0; i < mids.length; i += 500) {
		const rows = await db
			.insert(messages)
			.values(
				mids.slice(i, i + 500).map((mid, k) => ({
					ownerId: f.user.id,
					workspaceId: f.workspace.id,
					mailboxId,
					threadId: t.id,
					messageId: mid,
					subject: "big batch",
					text: "corps",
					date: new Date(Date.now() - (mids.length - i - k) * 1000),
					seen: true,
					metaData: { imap: { uid: firstUid + i + k, mailboxPath: "INBOX" } },
				})) as any,
			)
			.returning({ id: messages.id });
		ids.push(...rows.map((r) => r.id));
	}
	await upsertMailboxThreadItem(ids[ids.length - 1]);
	return { id: t.id, ids };
}

const msgRows = (ids: string[]) =>
	db.select().from(messages).where(inArray(messages.id, ids));

const threadRow = async (threadId: string, mailboxId: string) =>
	(
		await db
			.select()
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)))
	)[0];

const job = (threadIds: string[], mailboxId: string, moveImap: boolean) => ({
	threadId: threadIds[0],
	threadIds,
	mailboxId,
	op: "trash" as const,
	moveImap,
});

// Archive for a chosen duration: Trash job posted by mail:expire-tick.
const expiryJob = (threadIds: string[], mailboxId: string, moveImap: boolean) => ({ ...job(threadIds, mailboxId, moveImap), expiry: true });

const expOf = async (threadId: string, mailboxId: string) => (await threadRow(threadId, mailboxId))?.expiresAt ?? null;

const setExp = (threadId: string, mailboxId: string, at: Date | null) =>
	db
		.update(mailboxThreads)
		.set({ expiresAt: at })
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));

// One more message in an existing thread, folder thread row recomputed.
async function addMsg(f: Fixture, mailboxId: string, threadId: string, mid: string, uid: number | null = null, path = "INBOX") {
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: mid,
			subject: `thread ${mid}`,
			text: "corps",
			date: new Date(),
			seen: false,
			metaData: uid === null ? {} : { imap: { uid, mailboxPath: path } },
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return m.id;
}

async function main() {
	// 1. Trash requested as "database only" by a page without sync state, synced folder:
	//    IMAP MOVE done; permuted COPYUID, UIDs copied back by Message-ID; cursor.
	{
		const f = await createUserFixture("move-perm");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 930);
		await syncRow(f, trash.id, 99);
		const mids = Array.from({ length: 8 }, (_, i) => `<perm${i}-${Date.now()}@test.invalid>`);
		const imap = new FakeStalwart({
			INBOX: { uidNext: 931, msgs: mids.map((m, i) => [920 + i, m]) },
			"Deleted Items": { uidNext: 100, msgs: [] },
		});
		const t1 = await thread(f, f.inbox.id, mids.slice(0, 2).map((mid, i) => ({ mid, uid: 920 + i })));
		const t2 = await thread(f, f.inbox.id, mids.slice(2).map((mid, i) => ({ mid, uid: 922 + i })));
		// Database state seen from the server: right after the transaction (first lock) and
		// during the MOVE.
		let uidOnPath = -1;
		let cursorDuringMove = -1;
		imap.onLock = async () => {
			if (uidOnPath >= 0) return;
			const r = await msgRows([...t1.ids, ...t2.ids]);
			uidOnPath = r.filter((x) => (x.metaData as any)?.imap?.mailboxPath === "Deleted Items" && (x.metaData as any)?.imap?.uid !== undefined).length;
		};
		imap.onMove = async () => {
			cursorDuringMove = await cursorOf(trash.id);
		};
		await moveMail(job([t1.id, t2.id], f.inbox.id, false), on(f, imap));
		assert(uidOnPath === 0, `after the transaction, no source UID on the destination path (${uidOnPath})`);
		assert(cursorDuringMove === 99, `trash cursor unchanged during the MOVE (${cursorDuringMove})`);

		assert(imap.moves === 1, "database only requested, synced folder: un UID MOVE IMAP");
		const rows = await msgRows([...t1.ids, ...t2.ids]);
		const dest = imap.folders.get("Deleted Items")!;
		const ok = rows.filter((r) => {
			const uid = (r.metaData as any)?.imap?.uid;
			return r.mailboxId === trash.id && dest.msgs.get(uid) === r.messageId && (r.metaData as any)?.imap?.mailboxPath === "Deleted Items";
		});
		assert(ok.length === 8, `8/8 UIDs point to their own message despite the permuted COPYUID (${ok.length})`);
		assert(imap.folders.get("INBOX")!.msgs.size === 0, "IMAP INBOX emptied");
		assert((await cursorOf(trash.id)) === 107, "trash deltaFetch cursor on the last UID of the batch (107)");
		assert(!!(await threadRow(t2.id, trash.id)) && !(await threadRow(t2.id, f.inbox.id)), "thread row moved to trash");
	}

	// 2. Key collision: a thread already has its row in trash; the other threads of the batch go.
	{
		const f = await createUserFixture("move-clash");
		const trash = await trashOf(f);
		const t3 = await thread(f, f.inbox.id, [{ mid: `<c1-${Date.now()}@x>`, uid: null }]);
		const [old] = await db
			.insert(messages)
			.values({
				ownerId: f.user.id,
				workspaceId: f.workspace.id,
				mailboxId: trash.id,
				threadId: t3.id,
				messageId: `<c0-${Date.now()}@x>`,
				subject: "already in trash",
				text: "x",
				date: new Date(Date.now() - 3_600_000),
				seen: true,
			} as any)
			.returning();
		await upsertMailboxThreadItem(old.id);
		const t4 = await thread(f, f.inbox.id, [{ mid: `<c2-${Date.now()}@x>`, uid: null }]);
		let error: unknown = null;
		await moveMail(job([t3.id, t4.id], f.inbox.id, false), new Map()).catch((e) => (error = e));
		assert(error === null, `key collision: the job does not throw (${error})`);
		const merged = await threadRow(t3.id, trash.id);
		assert(merged?.messageCount === 2 && merged?.unreadCount === 1, "thread already in trash: rows merged (2 messages, 1 unread)");
		assert(!(await threadRow(t3.id, f.inbox.id)), "no Inbox row left for the merged thread");
		assert(!!(await threadRow(t4.id, trash.id)), "the other thread of the batch is in trash");
		const moved = await msgRows([...t3.ids, ...t4.ids]);
		assert(moved.every((m) => m.mailboxId === trash.id), "all messages of the batch in trash");
	}

	// 3. MOVE refused by the server (false without an error): database put back in Inbox, job failed.
	{
		const f = await createUserFixture("move-refuse");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 20);
		await syncRow(f, trash.id, 9);
		const mids = [`<r1-${Date.now()}@x>`, `<r2-${Date.now()}@x>`];
		const imap = new FakeStalwart({
			INBOX: { uidNext: 21, msgs: [[11, mids[0]], [12, mids[1]]] },
			"Deleted Items": { uidNext: 10, msgs: [] },
		});
		imap.refuseMove = true;
		const t5 = await thread(f, f.inbox.id, mids.map((mid, i) => ({ mid, uid: 11 + i })));
		await expectThrow(
			() => moveMail(job([t5.id], f.inbox.id, true), new Map([[f.identity.id, imap as unknown as ImapFlow]])),
			/2 message\(s\) not moved over IMAP/,
			"MOVE refused: the job fails (retried by BullMQ)",
		);
		const rows = await msgRows(t5.ids);
		assert(
			rows.every((r) => r.mailboxId === f.inbox.id && (r.metaData as any)?.imap?.mailboxPath === "INBOX") &&
				rows.map((r) => (r.metaData as any)?.imap?.uid).sort().join(",") === "11,12",
			"MOVE refused: messages put back in the Inbox in the database, original path and UID",
		);
		const back = await threadRow(t5.id, f.inbox.id);
		assert(!!back && back.messageCount === 2 && !(await threadRow(t5.id, trash.id)), "MOVE refused: thread row back in the Inbox");
		assert((await cursorOf(trash.id)) === 9, "MOVE refused: trash cursor restored to its value");
	}

	// 4. Partial MOVE (OK from the server): one message stays in the source, another disappears.
	{
		const f = await createUserFixture("move-partiel");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 40);
		await syncRow(f, trash.id, 4);
		const mids = [`<p1-${Date.now()}@x>`, `<p2-${Date.now()}@x>`, `<p3-${Date.now()}@x>`];
		const imap = new FakeStalwart({
			INBOX: { uidNext: 41, msgs: [[31, mids[0]], [32, mids[1]], [33, mids[2]]] },
			"Deleted Items": { uidNext: 5, msgs: [] },
		});
		imap.skipOnMove.add(32);
		imap.vanishOnMove.add(33);
		const t6 = await thread(f, f.inbox.id, mids.map((mid, i) => ({ mid, uid: 31 + i })));
		await expectThrow(
			() => moveMail(job([t6.id], f.inbox.id, true), on(f, imap)),
			/1 message\(s\) not moved over IMAP/,
			"partial MOVE: the job fails for the message left in the source",
		);
		const rows = new Map((await msgRows(t6.ids)).map((r) => [r.messageId, r]));
		const p1 = rows.get(mids[0])!;
		const p2 = rows.get(mids[1])!;
		const p3 = rows.get(mids[2])!;
		assert(p1.mailboxId === trash.id && (p1.metaData as any).imap.uid === 5, "partial MOVE: message arrived, arrival UID 5");
		assert(p2.mailboxId === f.inbox.id && (p2.metaData as any).imap.uid === 32, "partial MOVE: message left on the server put back in the Inbox (UID 32)");
		assert(p3.mailboxId === trash.id && (p3.metaData as any).imap.uid === undefined, "sent then not found anywhere: in trash, without UID");
		assert(!!(await threadRow(t6.id, f.inbox.id)) && !!(await threadRow(t6.id, trash.id)), "thread split over both folders, one row each");
		assert((await threadRow(t6.id, trash.id))!.messageCount === 2, "trash row recomputed (2 messages)");
		assert((await cursorOf(trash.id)) === 5, "trash cursor on the arrived UID (5)");
	}

	// 5. IMAP unavailable: nothing moves, neither in the database nor on the server.
	{
		const f = await createUserFixture("move-down");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 5);
		const t7 = await thread(f, f.inbox.id, [{ mid: `<d1-${Date.now()}@x>`, uid: 3 }]);
		await expectThrow(
			() => moveMail(job([t7.id], f.inbox.id, false), new Map()),
			/IMAP unavailable/,
			"IMAP unavailable: the job fails",
		);
		const [r] = await msgRows(t7.ids);
		assert(r.mailboxId === f.inbox.id && !(await threadRow(t7.id, trash.id)), "IMAP unavailable: database unchanged");
	}

	// 6. Message never sent in the MOVE: stale UID in the database, source folder of more than
	//    5,000 messages (no scan), empty SEARCH HEADER. It is put back in the source and not left
	//    "at the destination without a UID"; the rest of the batch goes.
	{
		const f = await createUserFixture("move-stale");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const a = `<perime-a-${Date.now()}@x>`;
		const b = `<perime-b-${Date.now()}@x>`;
		const c = `<other-thread-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[200, a], [201, b], [250, c]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.existsOverride = 6000;
		// a is actually at 200; the database says 250, which points to c (another thread)
		const t8 = await thread(f, f.inbox.id, [{ mid: a, uid: 250 }, { mid: b, uid: 201 }]);
		await expectThrow(
			() => moveMail(job([t8.id], f.inbox.id, true), on(f, imap)),
			/1 message\(s\) not moved over IMAP/,
			"stale UID: the job fails for the message never sent",
		);
		const rows = new Map((await msgRows(t8.ids)).map((r) => [r.messageId, r]));
		const ra = rows.get(a)!;
		const rb = rows.get(b)!;
		assert(
			ra.mailboxId === f.inbox.id && (ra.metaData as any).imap.uid === 250 && (ra.metaData as any).imap.mailboxPath === "INBOX",
			"stale UID: message put back in the Inbox in the database, not at the destination without a UID",
		);
		assert(rb.mailboxId === trash.id && (rb.metaData as any).imap.uid === 1, "stale UID: the other message of the batch left (UID 1)");
		assert(
			imap.folders.get("INBOX")!.msgs.get(250) === c && imap.folders.get("INBOX")!.msgs.get(200) === a,
			"stale UID: nothing else moved on the server",
		);
		assert(!!(await threadRow(t8.id, f.inbox.id)) && !!(await threadRow(t8.id, trash.id)), "stale UID: thread split, one row per folder");
	}

	// 6 bis. Messages already deleted from the server (absent from the source, read in full:
	//    folder of fewer than 5,000 messages) but still in the database. They are no longer put
	//    back in the source (they came back at every "empty the spam"): they stay at the
	//    destination without a UID, the rest of the batch goes, the job succeeds.
	{
		const f = await createUserFixture("move-ghost");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const g = `<ghost-${Date.now()}@x>`;
		const p = `<present-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[201, p]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		const tg = await thread(f, f.inbox.id, [{ mid: g, uid: 200 }]);
		const tp = await thread(f, f.inbox.id, [{ mid: p, uid: 201 }]);
		let error: unknown = null;
		await moveMail(job([tg.id, tp.id], f.inbox.id, true), on(f, imap)).catch((e) => (error = e));
		assert(error === null, `message deleted from the server: the job does not throw (${error})`);
		const [rg] = await msgRows(tg.ids);
		assert(
			rg.mailboxId === trash.id && (rg.metaData as any).imap.uid === undefined,
			"message deleted from the server: left at the destination without a UID, not put back in the source",
		);
		const [rp] = await msgRows(tp.ids);
		assert(rp.mailboxId === trash.id && (rp.metaData as any).imap.uid === 1, "the other thread of the batch left (UID 1)");
		assert(!(await threadRow(tg.id, f.inbox.id)), "no source row left for the thread deleted from the server");
	}

	// 7. Same Message-ID already in the destination folder (unique index mailbox_id + message_id):
	//    the source row is deleted, the IMAP copy goes anyway, the cursor counts it.
	{
		const f = await createUserFixture("move-copie");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 70);
		await syncRow(f, trash.id, 9);
		const x = `<copie-${Date.now()}@x>`;
		const y = `<seul-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 71, msgs: [[61, x], [62, y]] },
			"Deleted Items": { uidNext: 10, msgs: [[3, x]] },
		});
		const old = await thread(f, trash.id, [{ mid: x, uid: 3, path: "Deleted Items" }]);
		const t9 = await thread(f, f.inbox.id, [{ mid: x, uid: 61 }, { mid: y, uid: 62 }]);
		let error: unknown = null;
		await moveMail(job([t9.id], f.inbox.id, false), on(f, imap)).catch((e) => (error = e));
		assert(error === null, `same Message-ID already at the destination: the job does not throw (${error})`);
		const rows = await msgRows([...t9.ids, ...old.ids]);
		const xs = rows.filter((r) => r.messageId === x);
		assert(
			xs.length === 1 && xs[0].id === old.ids[0] && (xs[0].metaData as any).imap.uid === 3,
			"source row deleted, copy already at the destination intact (UID 3)",
		);
		const ry = rows.find((r) => r.messageId === y)!;
		assert(
			ry.mailboxId === trash.id && imap.folders.get("Deleted Items")!.msgs.get((ry.metaData as any).imap.uid) === y,
			"the other message of the thread is in trash with its UID",
		);
		assert(imap.folders.get("INBOX")!.msgs.size === 0, "the IMAP copy is moved too (INBOX empty)");
		assert((await cursorOf(trash.id)) === 11, "cursor on the last UID (11): the arrival UID of the copy counts as known");
		assert((await threadRow(t9.id, trash.id))?.messageCount === 1, "thread row recomputed (1 message)");
	}

	// 8. Two copies dropped at the destination for one message: most recent UID, and the cursor
	//    does not go back down below the batch.
	{
		const f = await createUserFixture("move-double");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 20);
		await syncRow(f, trash.id, 4);
		const d = `<double-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 21, msgs: [[15, d]] },
			"Deleted Items": { uidNext: 5, msgs: [] },
		});
		imap.duplicateOnMove.add(15);
		const t10 = await thread(f, f.inbox.id, [{ mid: d, uid: 15 }]);
		await moveMail(job([t10.id], f.inbox.id, true), on(f, imap));
		const [r] = await msgRows(t10.ids);
		assert((r.metaData as any).imap.uid === 6, "two copies at the destination: most recent UID (6)");
		assert((await cursorOf(trash.id)) === 6, "two copies at the destination: cursor above both (6)");
	}

	// 9. Big batch: 2,500 messages and 70,000 foreign arrivals during the MOVE (more than
	//    65,534 UIDs to check in the database); UIDs copied back in slices.
	{
		const f = await createUserFixture("move-gros");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 10_000);
		await syncRow(f, trash.id, 0);
		const n = 2500;
		const mids = Array.from({ length: n }, (_, i) => `<gros${i}-${Date.now()}@x>`);
		const imap = new FakeStalwart({
			INBOX: { uidNext: 10_001, msgs: mids.map((m, i) => [5000 + i, m] as [number, string]) },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.flood = 70_000;
		const t11 = await bigThread(f, f.inbox.id, mids, 5000);
		const t0 = Date.now();
		let error: unknown = null;
		await moveMail(job([t11.id], f.inbox.id, true), on(f, imap)).catch((e) => (error = e));
		const dt = ((Date.now() - t0) / 1000).toFixed(1);
		assert(error === null, `big batch: the job does not throw (${error})`);
		const dest = imap.folders.get("Deleted Items")!;
		const ok = (await msgRows(t11.ids)).filter(
			(r) => r.mailboxId === trash.id && dest.msgs.get((r.metaData as any)?.imap?.uid) === r.messageId,
		).length;
		assert(ok === n, `big batch: ${ok}/${n} correct UIDs, in ${dt} s`);
		assert((await cursorOf(trash.id)) === n, "big batch: cursor just below the first foreign arrival (2500)");
	}

	// 10. deltaFetch: a message already in this folder in the database is never a "move",
	//     and the copy in Sent (same Message-ID) is no longer deleted.
	{
		const f = await createUserFixture("delta-sent");
		const archive = await folderOf(f, "archive", "Archive");
		await syncRow(f, archive.id, 0);
		const x = `<sent-to-self-${Date.now()}@x>`;
		const sent = await thread(f, f.sent.id, [{ mid: x, uid: 7, path: "Sent" }]);
		const arch = await thread(f, archive.id, [{ mid: x, uid: 1, path: "Archive" }]);
		const imap = new FakeStalwart({ Archive: { uidNext: 2, msgs: [[1, x]] } });
		await deltaFetch(f.identity.id, on(f, imap));
		const rows = await msgRows([...sent.ids, ...arch.ids]);
		const s1 = rows.find((r) => r.id === sent.ids[0]);
		assert(!!s1 && s1.mailboxId === f.sent.id, "deltaFetch: the copy in Sent still exists, in Sent");
		assert(rows.find((r) => r.id === arch.ids[0])?.mailboxId === archive.id, "deltaFetch: the Archive copy did not move");
		assert((await cursorOf(archive.id)) === 1, "deltaFetch: Archive cursor advanced (1)");
	}

	// 11. Gmail: message already archived by another client, absent from the Inbox (absence
	//     proven) but present in "All Mail" at its original UID. It takes that UID over by
	//     Message-ID, without a MOVE; a UID already held by another row of the folder is never
	//     taken; a message deleted everywhere stays at the destination without a UID; one still
	//     in the Inbox leaves through the MOVE in the same batch; the job succeeds.
	{
		const f = await createUserFixture("move-gmail-already-archived");
		const all = await folderOf(f, "archive", "[Gmail]/All Mail");
		await syncRow(f, f.inbox.id, 9000);
		await syncRow(f, all.id, 9000);
		const a = `<Already-Archived-${Date.now()}@x>`;
		const held = `<uid-held-${Date.now()}@x>`;
		const deleted = `<deleted-everywhere-${Date.now()}@x>`;
		const present = `<still-in-inbox-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 9001, msgs: [[8000, `<unrelated-${Date.now()}@x>`], [8001, present]] },
			"[Gmail]/All Mail": { uidNext: 9001, msgs: [[500, a.toLowerCase()], [501, held]] },
		});
		imap.gmail = true;
		imap.existsOverride = 9000; // big Gmail folders: never scanned, SEARCH only
		const other = await thread(f, all.id, [{ mid: `<other-row-${Date.now()}@x>`, uid: 501, path: "[Gmail]/All Mail" }]);
		const t = await thread(f, f.inbox.id, [{ mid: a, uid: 7000 }, { mid: held, uid: 7001 }, { mid: deleted, uid: 7002 }, { mid: present, uid: 8001 }]);
		let error: unknown = null;
		await moveMail({ threadId: t.id, threadIds: [t.id], mailboxId: f.inbox.id, op: "archive", moveImap: true }, on(f, imap)).catch((e) => (error = e));
		assert(error === null, `Gmail, already archived: the job does not throw (${error})`);
		assert(imap.moves === 1 && !imap.folders.get("INBOX")!.msgs.has(8001), `Gmail, already archived: a single UID MOVE, for the message still in the Inbox (${imap.moves})`);
		const rows = new Map((await msgRows(t.ids)).map((r) => [r.messageId, r]));
		const ra = rows.get(a)!;
		assert(
			ra.mailboxId === all.id && (ra.metaData as any).imap.uid === 500 && (ra.metaData as any).imap.mailboxPath === "[Gmail]/All Mail",
			`Gmail, already archived: "All Mail" UID taken over by Message-ID (${JSON.stringify((ra.metaData as any).imap)})`,
		);
		const rp = rows.get(held)!;
		assert(rp.mailboxId === all.id && (rp.metaData as any).imap.uid === undefined, "Gmail, already archived: a UID held by another row of the folder is never taken");
		const [ro] = await msgRows(other.ids);
		assert((ro.metaData as any).imap.uid === 501, "Gmail, already archived: the other row keeps its UID");
		const rs = rows.get(deleted)!;
		assert(rs.mailboxId === all.id && (rs.metaData as any).imap.uid === undefined, "Gmail, deleted everywhere: at the destination without a UID");
		const rn = rows.get(present)!;
		assert(rn.mailboxId === all.id && (rn.metaData as any).imap.uid === 9001, `Gmail, still in the Inbox: arrival UID of the MOVE (${JSON.stringify((rn.metaData as any).imap)})`);
		assert((await cursorOf(all.id)) === 9001, "Gmail, already archived: the \"All Mail\" cursor is beyond the single message that arrived");
	}

	// 12. Row without a UID in a synced folder (left without one by a previous move): looked up
	//     by Message-ID in the source instead of a "database only" move (the database said
	//     Trash, Gmail kept the message in the Inbox). Not found without proof of absence (big
	//     Stalwart folder, failed SEARCH): moved in the database only as before, without a UID,
	//     and the job succeeds (never a job that fails endlessly because of it).
	{
		const f = await createUserFixture("move-no-uid");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const s = `<no-uid-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[210, s]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.gmail = true;
		// IMAP path of the folder, as in production (the fixture only has the name "Inbox")
		await db.update(mailboxes).set({ metaData: { imap: { path: "INBOX" } } }).where(eq(mailboxes.id, f.inbox.id));
		const ts = await thread(f, f.inbox.id, [{ mid: s, uid: null }]);
		await moveMail(job([ts.id], f.inbox.id, true), on(f, imap));
		assert(imap.moves === 1 && !imap.folders.get("INBOX")!.msgs.has(210), "no UID: IMAP MOVE done (found by Message-ID)");
		const [r] = await msgRows(ts.ids);
		assert(
			r.mailboxId === trash.id && (r.metaData as any)?.imap?.uid === 1 && imap.folders.get("Deleted Items")!.msgs.get(1) === s,
			`no UID: in the trash with its arrival UID (${JSON.stringify(r.metaData)})`,
		);

		const f2 = await createUserFixture("move-no-uid-not-found");
		const trash2 = await trashOf(f2);
		await syncRow(f2, f2.inbox.id, 300);
		await syncRow(f2, trash2.id, 0);
		const n = `<not-found-${Date.now()}@x>`;
		const imap2 = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[220, n]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap2.existsOverride = 6000;
		await db.update(mailboxes).set({ metaData: { imap: { path: "INBOX" } } }).where(eq(mailboxes.id, f2.inbox.id));
		const tn = await thread(f2, f2.inbox.id, [{ mid: n, uid: null }]);
		let error2: unknown = null;
		await moveMail(job([tn.id], f2.inbox.id, true), on(f2, imap2)).catch((e) => (error2 = e));
		assert(error2 === null, `no UID, not found without proof: the job does not throw (${error2})`);
		const [r2] = await msgRows(tn.ids);
		assert(
			r2.mailboxId === trash2.id && (r2.metaData as any)?.imap?.uid === undefined && imap2.moves === 0 && imap2.folders.get("INBOX")!.msgs.has(220),
			`no UID, not found without proof: in the trash in the database only, without a UID, server unchanged (${JSON.stringify(r2.metaData)})`,
		);
	}

	// 13. Messages whose meta is the JSON `null` (not the SQL NULL: an insert that omits meta got
	//     the jsonb 'null' DEFAULT): coalesce does not replace them, `'null'::jsonb || object`
	//     builds an array and jsonb_set fails there. The move succeeds (arrival UID copied
	//     back); a message the server did not move is put back in the source with an object meta.
	{
		const f = await createUserFixture("move-meta-null");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const a = `<meta-null-a-${Date.now()}@x>`;
		const b = `<meta-null-b-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[210, a], [211, b]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.skipOnMove.add(211);
		await db.update(mailboxes).set({ metaData: { imap: { path: "INBOX" } } }).where(eq(mailboxes.id, f.inbox.id));
		const ta = await thread(f, f.inbox.id, [{ mid: a, uid: null, nullMeta: true }]);
		const tb = await thread(f, f.inbox.id, [{ mid: b, uid: null, nullMeta: true }]);
		const typeOf = async (id: string) =>
			String((await db.execute(sql`select coalesce(jsonb_typeof(meta), 'sql-null') as t from messages where id = ${id}::uuid`))[0]?.t);
		assert((await typeOf(ta.ids[0])) === "null", "meta null: the fixture does write the JSON null");
		let error: unknown = null;
		await moveMail(job([ta.id], f.inbox.id, true), on(f, imap)).catch((e) => (error = e));
		assert(error === null, `meta null: the job does not throw (${error})`);
		const [ra] = await msgRows(ta.ids);
		assert(
			ra.mailboxId === trash.id && (ra.metaData as any)?.imap?.mailboxPath === "Deleted Items" && imap.folders.get("Deleted Items")!.msgs.get(1) === a && (ra.metaData as any)?.imap?.uid === 1,
			`meta null: in the trash with path and arrival UID (${JSON.stringify(ra.metaData)})`,
		);
		await expectThrow(() => moveMail(job([tb.id], f.inbox.id, true), on(f, imap)), /not moved over IMAP/, "meta null, not moved by the server: the job fails to be replayed");
		const [rb] = await msgRows(tb.ids);
		assert(
			rb.mailboxId === f.inbox.id && (await typeOf(tb.ids[0])) === "object" && (rb.metaData as any)?.imap?.mailboxPath === "INBOX" && imap.folders.get("INBOX")!.msgs.has(211),
			`meta null, not moved by the server: put back in the Inbox, object meta (${JSON.stringify(rb.metaData)})`,
		);
	}

	// 14. Archive for a chosen duration: the expiry travels in the job (op archive, expiresAt) and
	//     moveMail writes it on the arrival row, in the move's transaction; any other move writes
	//     NULL. The Trash job posted by the tick (expiry: true) checks the expiry again when it runs.
	const X = new Date(Date.now() + 30 * 86_400_000);
	const PAST = new Date(Date.now() - 3_600_000);
	const same = (a: Date | null, b: Date) => !!a && a.getTime() === b.getTime();
	{
		const f = await createUserFixture("expiry-archive");
		const archive = await folderOf(f, "archive", "Archive");
		const custom = await folderOf(f, "custom", "Projects");
		const tag = Date.now();

		// a) simple path
		const ta = await thread(f, f.inbox.id, [{ mid: `<exp-a-${tag}@x>`, uid: null }]);
		await moveMail({ ...job([ta.id], f.inbox.id, false), op: "archive", expiresAt: X.toISOString() }, new Map());
		assert(same(await expOf(ta.id, archive.id), X), `a) archive with an expiry, simple path: Archive row at the expiry (${await expOf(ta.id, archive.id)})`);

		// b) plain archive of a thread whose source row carried an expiry
		const tb = await thread(f, f.inbox.id, [{ mid: `<exp-b-${tag}@x>`, uid: null }]);
		await setExp(tb.id, f.inbox.id, X);
		await moveMail({ ...job([tb.id], f.inbox.id, false), op: "archive" }, new Map());
		assert(!!(await threadRow(tb.id, archive.id)) && (await expOf(tb.id, archive.id)) === null, "b) archive without an expiry: Archive row without an expiry, even if the source carried one");

		// c) collision: the thread already has its row in Archive (Gmail "All Mail" case)
		const tc = await thread(f, archive.id, [{ mid: `<exp-c0-${tag}@x>`, uid: null }]);
		await addMsg(f, f.inbox.id, tc.id, `<exp-c1-${tag}@x>`);
		await moveMail({ ...job([tc.id], f.inbox.id, false), op: "archive", expiresAt: X.toISOString() }, new Map());
		const rc = await threadRow(tc.id, archive.id);
		assert(rc?.messageCount === 2 && same(rc.expiresAt, X) && !(await threadRow(tc.id, f.inbox.id)), `c) collision: arrival row merged, at the expiry (${rc?.messageCount}, ${rc?.expiresAt})`);

		// c2) invalid or past date: plain archive
		const tc2 = await thread(f, f.inbox.id, [{ mid: `<exp-c2-${tag}@x>`, uid: null }]);
		await moveMail({ ...job([tc2.id], f.inbox.id, false), op: "archive", expiresAt: PAST.toISOString() }, new Map());
		assert(!!(await threadRow(tc2.id, archive.id)) && (await expOf(tc2.id, archive.id)) === null, "c2) past expiry: archive without an expiry");

		// d) move out of Archive (custom folder, then back to the Inbox)
		const td = await thread(f, archive.id, [{ mid: `<exp-d-${tag}@x>`, uid: null }]);
		await setExp(td.id, archive.id, X);
		await moveMail({ threadId: td.id, threadIds: [td.id], mailboxId: archive.id, op: "move", toMailboxId: custom.id, moveImap: false, expiresAt: X.toISOString() }, new Map());
		assert(!!(await threadRow(td.id, custom.id)) && (await expOf(td.id, custom.id)) === null, "d) move to a custom folder: expiry NULL (expiresAt ignored outside Archive)");
		const td2 = await thread(f, archive.id, [{ mid: `<exp-d2-${tag}@x>`, uid: null }]);
		await setExp(td2.id, archive.id, X);
		await moveMail({ threadId: td2.id, threadIds: [td2.id], mailboxId: archive.id, op: "move", toMailboxId: f.inbox.id, moveImap: false }, new Map());
		assert(!!(await threadRow(td2.id, f.inbox.id)) && (await expOf(td2.id, f.inbox.id)) === null, "d) unarchive: Inbox row without an expiry");

		// f) trigger: star on a row with an expiry, expiry written on a starred row
		const tf = await thread(f, archive.id, [{ mid: `<exp-f-${tag}@x>`, uid: null }]);
		await setExp(tf.id, archive.id, X);
		await db.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, tf.id), eq(mailboxThreads.mailboxId, archive.id)));
		assert((await expOf(tf.id, archive.id)) === null, "f) star set: expiry NULL");
		await setExp(tf.id, archive.id, X);
		assert((await expOf(tf.id, archive.id)) === null, "f) expiry written on a starred row: stays NULL");

		// g) message of the same thread in the Inbox: Archive row expiry cleared;
		//    a message of the thread in Sent does not clear it
		const tg = await thread(f, archive.id, [{ mid: `<exp-g-${tag}@x>`, uid: null }]);
		await setExp(tg.id, archive.id, X);
		await addMsg(f, f.sent.id, tg.id, `<exp-g-sent-${tag}@x>`);
		assert(same(await expOf(tg.id, archive.id), X), "g) message of the thread in Sent: expiry kept");
		await addMsg(f, f.inbox.id, tg.id, `<exp-g-inbox-${tag}@x>`);
		assert((await expOf(tg.id, archive.id)) === null, "g) message of the thread in the Inbox: Archive row expiry NULL");
	}

	// 14 e) MOVE refused by the server during an archive with an expiry: row back in the source,
	//     without an expiry (Inbox source, and custom folder source, where the Inbox does not clear it).
	for (const src of ["Inbox", "Projects"] as const) {
		const f = await createUserFixture(`expiry-refuse-${src}`);
		const archive = await folderOf(f, "archive", "Archive");
		const from = src === "Inbox" ? f.inbox : await folderOf(f, "custom", "Projects");
		const path = src === "Inbox" ? "INBOX" : "Projects";
		await syncRow(f, from.id, 20);
		await syncRow(f, archive.id, 9);
		const mid = `<exp-e-${src}-${Date.now()}@x>`;
		const imap = new FakeStalwart({ [path]: { uidNext: 21, msgs: [[11, mid]] }, Archive: { uidNext: 10, msgs: [] } });
		imap.refuseMove = true;
		const te = await thread(f, from.id, [{ mid, uid: 11, path }]);
		await expectThrow(
			() => moveMail({ ...job([te.id], from.id, true), op: "archive", expiresAt: X.toISOString() }, on(f, imap)),
			/not moved over IMAP/,
			`e) ${src}: MOVE refused, the job fails`,
		);
		const back = await threadRow(te.id, from.id);
		assert(!!back && back.expiresAt === null && !(await threadRow(te.id, archive.id)), `e) ${src}: row back in the source, expiry NULL (${back?.expiresAt})`);
	}

	// 14 h) tick job (expiry: true) on a due thread: in Trash, over IMAP too, expiry NULL;
	//     messageIds ignored (the whole thread leaves).
	{
		const f = await createUserFixture("expiry-due");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		await syncRow(f, archive.id, 50);
		await syncRow(f, trash.id, 0);
		const m1 = `<exp-h1-${Date.now()}@x>`;
		const m2 = `<exp-h2-${Date.now()}@x>`;
		const imap = new FakeStalwart({ Archive: { uidNext: 51, msgs: [[40, m1], [41, m2]] }, "Deleted Items": { uidNext: 1, msgs: [] } });
		const th = await thread(f, archive.id, [{ mid: m1, uid: 40, path: "Archive" }, { mid: m2, uid: 41, path: "Archive" }]);
		await setExp(th.id, archive.id, PAST);
		await moveMail({ ...expiryJob([th.id], archive.id, true), messageIds: [th.ids[0]] }, on(f, imap));
		const rows = await msgRows(th.ids);
		assert(rows.length === 2 && rows.every((r) => r.mailboxId === trash.id), "h) due thread: all its messages in Trash (messageIds ignored)");
		assert(imap.folders.get("Archive")!.msgs.size === 0 && imap.folders.get("Deleted Items")!.msgs.size === 2, "h) due thread: moved over IMAP");
		const tr = await threadRow(th.id, trash.id);
		assert(!!tr && tr.expiresAt === null && !(await threadRow(th.id, archive.id)), `h) due thread: Trash row, expiry NULL (${tr?.expiresAt})`);
	}

	// 14 i) tick job on a thread whose expiry was cleared, is in the future, has a sister Inbox row,
	//     or whose source is not Archive: nothing moves.
	{
		const f = await createUserFixture("expiry-not-due");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		const tag = Date.now();
		const cleared = await thread(f, archive.id, [{ mid: `<exp-i1-${tag}@x>`, uid: null }]);
		const future = await thread(f, archive.id, [{ mid: `<exp-i2-${tag}@x>`, uid: null }]);
		await setExp(future.id, archive.id, X);
		const sister = await thread(f, archive.id, [{ mid: `<exp-i3-${tag}@x>`, uid: null }]);
		const sisterInbox = await addMsg(f, f.inbox.id, sister.id, `<exp-i3-inbox-${tag}@x>`);
		await setExp(sister.id, archive.id, PAST);
		await moveMail(expiryJob([cleared.id, future.id, sister.id], archive.id, false), new Map());
		const rows = await msgRows([...cleared.ids, ...future.ids, ...sister.ids]);
		assert(rows.every((r) => r.mailboxId === archive.id), "i) cleared expiry, future, or sister Inbox row: nothing leaves");
		const [si] = await msgRows([sisterInbox]);
		assert(si.mailboxId === f.inbox.id, "i) the thread's Inbox message stays in the Inbox");
		assert(
			!(await threadRow(cleared.id, trash.id)) && !(await threadRow(future.id, trash.id)) && !(await threadRow(sister.id, trash.id)),
			"i) no row in Trash",
		);
		const inboxDue = await thread(f, f.inbox.id, [{ mid: `<exp-i4-${tag}@x>`, uid: null }]);
		await setExp(inboxDue.id, f.inbox.id, PAST);
		await moveMail(expiryJob([inboxDue.id], f.inbox.id, false), new Map());
		const [ri] = await msgRows(inboxDue.ids);
		assert(ri.mailboxId === f.inbox.id, "i) source other than Archive: nothing leaves");
	}

	// 14 j) tick job, MOVE refused then partial: the Archive row keeps its expiry (otherwise the
	//     replayed job would find nothing and the thread would stay in Archive without an expiry, with
	//     no trace), and the replayed job finishes the work.
	{
		const f = await createUserFixture("expiry-retry");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		await syncRow(f, archive.id, 50);
		await syncRow(f, trash.id, 0);
		const m1 = `<exp-j1-${Date.now()}@x>`;
		const m2 = `<exp-j2-${Date.now()}@x>`;
		const imap = new FakeStalwart({ Archive: { uidNext: 51, msgs: [[40, m1], [41, m2]] }, "Deleted Items": { uidNext: 1, msgs: [] } });
		const tj = await thread(f, archive.id, [{ mid: m1, uid: 40, path: "Archive" }, { mid: m2, uid: 41, path: "Archive" }]);
		await setExp(tj.id, archive.id, PAST);
		imap.refuseMove = true;
		await expectThrow(() => moveMail(expiryJob([tj.id], archive.id, true), on(f, imap)), /2 message\(s\) not moved over IMAP/, "j) MOVE refused: the job fails");
		assert(same(await expOf(tj.id, archive.id), PAST), `j) MOVE refused: the Archive row keeps its expiry (${await expOf(tj.id, archive.id)})`);
		imap.refuseMove = false;
		imap.skipOnMove.add(41);
		await expectThrow(() => moveMail(expiryJob([tj.id], archive.id, true), on(f, imap)), /1 message\(s\) not moved over IMAP/, "j) partial MOVE: the job fails");
		assert(same(await expOf(tj.id, archive.id), PAST), `j) partial MOVE: the recomputed Archive row keeps its expiry (${await expOf(tj.id, archive.id)})`);
		assert((await expOf(tj.id, trash.id)) === null, "j) partial MOVE: the Trash row has no expiry");
		imap.skipOnMove.clear();
		await moveMail(expiryJob([tj.id], archive.id, true), on(f, imap));
		const rows = await msgRows(tj.ids);
		assert(rows.every((r) => r.mailboxId === trash.id) && !(await threadRow(tj.id, archive.id)), "j) replayed job: the thread is in Trash");
	}

	// 14 k) star set while the tick job runs (between the check and the transaction, where the
	//     worker waits for the IMAP connection): the transaction checks again under lock, nothing leaves.
	{
		const f = await createUserFixture("expiry-race");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		const tk = await thread(f, archive.id, [{ mid: `<exp-k-${Date.now()}@x>`, uid: null }]);
		await setExp(tk.id, archive.id, PAST);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let held!: () => void;
		const holding = new Promise<void>((r) => (held = r));
		const star = db.transaction(async (tx) => {
			await tx.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, tk.id), eq(mailboxThreads.mailboxId, archive.id)));
			held();
			await gate;
		});
		await holding;
		const mv = moveMail(expiryJob([tk.id], archive.id, false), new Map());
		let waited = false;
		for (let i = 0; i < 100 && !waited; i++) {
			const [w] = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
			waited = Number((w as any)?.n) > 0;
			if (!waited) await new Promise((r) => setTimeout(r, 50));
		}
		assert(waited, "k) the job waits for the lock on the starred row");
		release();
		await star;
		await mv;
		const [rk] = await msgRows(tk.ids);
		assert(rk.mailboxId === archive.id && !(await threadRow(tk.id, trash.id)), "k) star set during the job: the thread stays in Archive");
	}

	// 14 l) star set outside kurrier (phone, Gmail web) on an already archived thread: IDLE only
	//     follows the INBOX, the database ignores it. The tick job reads the flags before the MOVE:
	//     a thread with a \Flagged message stays in Archive, starred, without an expiry, without
	//     failing the job; the other threads leave. All threads starred: no MOVE.
	{
		const f = await createUserFixture("expiry-flagged");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		await syncRow(f, archive.id, 50);
		await syncRow(f, trash.id, 0);
		const m1 = `<exp-l1-${Date.now()}@x>`;
		const m2 = `<exp-l2-${Date.now()}@x>`;
		const m3 = `<exp-l3-${Date.now()}@x>`;
		const m0 = `<exp-l0-${Date.now()}@x>`; // database only: absent from the server
		const imap = new FakeStalwart({ Archive: { uidNext: 51, msgs: [[40, m1], [41, m2], [42, m3]] }, "Deleted Items": { uidNext: 1, msgs: [] } });
		imap.flagged.add(m2);
		const tl = await thread(f, archive.id, [{ mid: m1, uid: 40, path: "Archive" }, { mid: m2, uid: 41, path: "Archive" }, { mid: m0, uid: 39, path: "Archive" }]);
		const tm = await thread(f, archive.id, [{ mid: m3, uid: 42, path: "Archive" }]);
		await setExp(tl.id, archive.id, PAST);
		await setExp(tm.id, archive.id, PAST);
		await moveMail(expiryJob([tl.id, tm.id], archive.id, true), on(f, imap));
		const rl = await msgRows(tl.ids);
		assert(rl.length === 3 && rl.every((r) => r.mailboxId === archive.id), "l) thread starred elsewhere: its messages stay in Archive in the database, the one absent from the server too");
		assert(rl.find((r) => r.messageId === m2)?.flagged === true && rl.find((r) => r.messageId === m1)?.flagged === false, "l) thread starred elsewhere: the \\Flagged message is starred in the database, the other is not");
		const kept = await threadRow(tl.id, archive.id);
		assert(!!kept && kept.starred === true && kept.expiresAt === null, `l) thread starred elsewhere: Archive row starred, expiry NULL (${kept?.starred} ${kept?.expiresAt})`);
		assert(!(await threadRow(tl.id, trash.id)), "l) thread starred elsewhere: no row in Trash");
		const sv = imap.folders.get("Archive")!.msgs;
		assert(sv.get(40) === m1 && sv.get(41) === m2 && sv.size === 2, "l) thread starred elsewhere: nothing of this thread moved over IMAP");
		const [rm] = await msgRows(tm.ids);
		assert(rm.mailboxId === trash.id && [...imap.folders.get("Deleted Items")!.msgs.values()].includes(m3), "l) the other thread of the batch goes to Trash, over IMAP too");

		// Every thread of the batch starred elsewhere: no MOVE sent, the job succeeds.
		const m4 = `<exp-l4-${Date.now()}@x>`;
		imap.folders.get("Archive")!.msgs.set(43, m4);
		imap.flagged.add(m4);
		const tn = await thread(f, archive.id, [{ mid: m4, uid: 43, path: "Archive" }]);
		await setExp(tn.id, archive.id, PAST);
		const before = imap.moves;
		await moveMail(expiryJob([tn.id], archive.id, true), on(f, imap));
		assert(imap.moves === before, `l) all threads starred: no MOVE (${imap.moves - before})`);
		const rn = await threadRow(tn.id, archive.id);
		assert(!!rn && rn.starred === true && rn.expiresAt === null && !(await threadRow(tn.id, trash.id)), "l) all threads starred: thread in Archive, starred, expiry NULL");
		// The next tick no longer picks it up.
		assert((await dueExpiredThreads(db, { now: new Date(), mailboxId: archive.id })).every((t) => t.threadId !== tn.id && t.threadId !== tl.id), "l) starred threads: no longer due for the tick");

		// Rollback: thread starred elsewhere and an unstarred thread, MOVE refused. Only the second
		// counts in the job failure and keeps its expiry; the first is starred, without an expiry.
		const m5 = `<exp-l5-${Date.now()}@x>`;
		const m6 = `<exp-l6-${Date.now()}@x>`;
		imap.folders.get("Archive")!.msgs.set(44, m5);
		imap.folders.get("Archive")!.msgs.set(45, m6);
		imap.flagged.add(m5);
		const tp = await thread(f, archive.id, [{ mid: m5, uid: 44, path: "Archive" }]);
		const tq = await thread(f, archive.id, [{ mid: m6, uid: 45, path: "Archive" }]);
		await setExp(tp.id, archive.id, PAST);
		await setExp(tq.id, archive.id, PAST);
		imap.refuseMove = true;
		await expectThrow(() => moveMail(expiryJob([tp.id, tq.id], archive.id, true), on(f, imap)), /1 message\(s\) not moved over IMAP/, "l) MOVE refused: only the unstarred thread fails the job");
		imap.refuseMove = false;
		const rp = await threadRow(tp.id, archive.id);
		assert(!!rp && rp.starred === true && rp.expiresAt === null && !(await threadRow(tp.id, trash.id)), "l) MOVE refused: thread starred elsewhere in Archive, starred, expiry NULL");
		assert(same(await expOf(tq.id, archive.id), PAST) && !(await threadRow(tq.id, trash.id)), `l) MOVE refused: the other thread comes back to Archive with its expiry (${await expOf(tq.id, archive.id)})`);
	}
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
