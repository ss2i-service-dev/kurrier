// moveMail end to end on a test database, with a fake IMAP server that behaves like
// Stalwart: permuted COPYUID, empty SEARCH HEADER Message-ID, no scan beyond 5,000
// messages, MOVE refused (false without an error) or partial. Checks: UIDs copied back by
// Message-ID (in slices), deltaFetch cursor of the destination folder (written once, after
// the MOVE, duplicates included), IMAP trash even when the page says "database only", key
// collisions (mailbox_threads, and messages: same Message-ID already at the destination)
// without losing the other threads, UID removed from the transaction on, database rollback
// of what the server did not move (including what was never sent), IMAP unavailable =
// nothing moves, batch of more than 65,534 arrived UIDs, and deltaFetch no longer deleting
// the copy in Sent.
// Test database: see mcp-test-env.ts:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55436/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/move-imap.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { moveMail } from "../lib/imap/imap-move";
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
	async search() {
		return []; // Stalwart returns nothing on SEARCH HEADER Message-ID
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
				flags: new Set<string>(["\\Seen"]),
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

async function folderOf(f: Fixture, kind: "archive" | "spam", name: string) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind,
			name,
			slug: kind,
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
async function thread(f: Fixture, mailboxId: string, items: Array<{ mid: string; uid: number | null; path?: string }>) {
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
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
