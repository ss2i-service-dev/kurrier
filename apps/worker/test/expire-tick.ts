// Archive for a chosen duration: the mail:expire-tick tick posts one mail:move job (op trash,
// expiry: true) per Archive folder that has due threads, with a jobId stable within the hour; it
// never touches the expiry of a due thread (the move clears it) and resets to NULL the expiry of
// rows outside Archive or with a sister Inbox row.
// Test database: see mcp-test-env.ts:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55437/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/expire-tick.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { expiryBucket, upsertMailboxThreadItem } from "@common";
import { and, eq } from "drizzle-orm";
import { runExpiryTick } from "../lib/mail-expiry";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

async function folderOf(f: Fixture, kind: "archive" | "custom", name: string) {
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

// A one-message thread in `mailboxId`, or one more message in the `existing` thread.
async function msgIn(f: Fixture, mailboxId: string, existing?: string): Promise<string> {
	const threadId =
		existing ?? (await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() }).returning())[0].id;
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: `<tick-${Math.random().toString(36).slice(2)}@x>`,
			subject: "thread",
			text: "body",
			date: new Date(),
			seen: true,
			metaData: {},
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return threadId;
}

const row = async (threadId: string, mailboxId: string) =>
	(await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId))))[0];

const setExp = (threadId: string, mailboxId: string, at: Date | null) =>
	db
		.update(mailboxThreads)
		.set({ expiresAt: at })
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));

type Call = { name: string; data: any; opts: any };

async function tick(now: Date) {
	const calls: Call[] = [];
	await runExpiryTick({ now, enqueue: async (name, data, opts) => void calls.push({ name, data, opts }) });
	return calls;
}

async function main() {
	const now = new Date();
	const PAST = new Date(now.getTime() - 3_600_000);
	const FUTURE = new Date(now.getTime() + 30 * 86_400_000);

	const f = await createUserFixture("expire-tick");
	const archive = await folderOf(f, "archive", "Archive");
	const custom = await folderOf(f, "custom", "Projects");

	const due = await msgIn(f, archive.id);
	await setExp(due, archive.id, PAST);
	const notDue = await msgIn(f, archive.id);
	await setExp(notDue, archive.id, FUTURE);
	const starred = await msgIn(f, archive.id);
	await db.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, starred), eq(mailboxThreads.mailboxId, archive.id)));
	await setExp(starred, archive.id, PAST);
	const sister = await msgIn(f, archive.id);
	await msgIn(f, f.inbox.id, sister);
	await setExp(sister, archive.id, PAST);
	const outside = await msgIn(f, custom.id);
	await setExp(outside, custom.id, PAST);

	const calls = await tick(now);
	const mine = calls.filter((c) => c.data?.mailboxId === archive.id || c.data?.mailboxId === custom.id || c.data?.mailboxId === f.inbox.id);
	assert(mine.length === 1, `a single job for the fixture's Archive (${mine.length})`);
	const [c] = mine;
	assert(c?.name === "mail:move" && c.data.op === "trash" && c.data.expiry === true && c.data.mailboxId === archive.id, `mail:move job, op trash, expiry, from Archive (${JSON.stringify(c?.data)})`);
	assert(JSON.stringify(c?.data.threadIds) === JSON.stringify([due]) && c?.data.threadId === due, "only the due thread leaves (not due, starred, sister Inbox row, outside Archive: no)");
	assert(c?.data.moveImap === false, "Archive without mailbox_sync: moveImap false");
	assert(c?.opts?.jobId === `expire-${archive.id}-${expiryBucket(now)}`, `jobId expire-<folder>-<UTC hour> (${c?.opts?.jobId})`);
	assert(c?.opts?.attempts === 8 && c?.opts?.backoff?.type === "exponential" && c?.opts?.removeOnComplete === true, "job replayed on failure (8 attempts, exponential backoff)");

	assert((await row(due, archive.id))?.expiresAt?.getTime() === PAST.getTime(), "the tick does not clear the expiry of a due thread (the move does)");
	assert((await row(notDue, archive.id))?.expiresAt?.getTime() === FUTURE.getTime(), "thread not due: expiry kept");
	assert((await row(outside, custom.id))?.expiresAt === null, "row with an expiry outside Archive: reset to NULL");
	assert((await row(sister, archive.id))?.expiresAt === null, "Archive row with a sister Inbox row: reset to NULL");

	const again = (await tick(now)).filter((x) => x.data?.mailboxId === archive.id);
	assert(again.length === 1 && again[0].opts.jobId === c?.opts?.jobId, "two runs in a row: same jobId (BullMQ keeps only one)");

	// Archive synced over IMAP: the job asks for the IMAP MOVE.
	const g = await createUserFixture("expire-tick-sync");
	const archiveSync = await folderOf(g, "archive", "Archive");
	await db.insert(mailboxSync).values({ identityId: g.identity.id, mailboxId: archiveSync.id, uidValidity: BigInt(1), lastSeenUid: 1 });
	const dueSync = await msgIn(g, archiveSync.id);
	await setExp(dueSync, archiveSync.id, PAST);
	const synced = (await tick(now)).filter((x) => x.data?.mailboxId === archiveSync.id);
	assert(synced.length === 1 && synced[0].data.moveImap === true, "synced Archive: moveImap true");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
