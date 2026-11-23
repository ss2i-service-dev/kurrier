import { db } from "@db";
import { expiryBucket } from "@common";
import { sql } from "drizzle-orm";

// Archive for a chosen duration. The expiry lives on the mailbox_threads row of the thread in the
// archive folder (expires_at, migration community_009). The mail:expire-tick tick (common-worker,
// every 15 min) posts one mail:move job op trash `expiry: true` per folder; moveMail checks the
// expiry again at the start of the job then under lock (dueExpiredThreads), so the tick has
// nothing to guarantee about the window in between. Never a permanent deletion: the thread goes
// to Trash by the usual path.

type Dbh = { execute: (q: any) => Promise<any> };

export type DueThread = { threadId: string; mailboxId: string; identityId: string; expiresAt: Date };

// A row of the same thread and the same identity in the Inbox cancels the expiry: the thread is
// back (reply received, partial unarchive).
const inboxSister = sql`exists (
	select 1 from mailbox_threads s join mailboxes sb on sb.id = s.mailbox_id
	where s.thread_id = mt.thread_id and s.identity_id = mt.identity_id and sb.kind = 'inbox'
)`;

const due = (now: Date) => sql`mt.expires_at is not null
	and mt.expires_at <= ${now.toISOString()}::timestamptz
	and not mt.starred
	and not ${inboxSister}`;

// Due threads of an archive folder: expiry passed, not starred, no sister Inbox row. forUpdate
// (inside the move's transaction): rows locked, and read again after waiting for a lock (READ
// COMMITTED): a star set in the meantime excludes them.
export async function dueExpiredThreads(
	dbh: Dbh,
	o: { now: Date; mailboxId?: string; threadIds?: string[]; limit?: number; forUpdate?: boolean },
): Promise<DueThread[]> {
	if (o.threadIds && !o.threadIds.length) return [];
	const rows = await dbh.execute(sql`
		select mt.thread_id, mt.mailbox_id, mt.identity_id, mt.expires_at
		from mailbox_threads mt
		join mailboxes mb on mb.id = mt.mailbox_id and mb.kind = 'archive'
		where ${due(o.now)}
		${o.mailboxId ? sql`and mt.mailbox_id = ${o.mailboxId}::uuid` : sql``}
		${o.threadIds ? sql`and mt.thread_id = any(${`{${o.threadIds.join(",")}}`}::uuid[])` : sql``}
		order by mt.expires_at, mt.thread_id
		${o.limit ? sql`limit ${o.limit}` : sql``}
		${o.forUpdate ? sql`for update of mt` : sql``}
	`);
	return (rows as any[]).map((r) => ({
		threadId: String(r.thread_id),
		mailboxId: String(r.mailbox_id),
		identityId: String(r.identity_id),
		expiresAt: new Date(r.expires_at),
	}));
}

export type Enqueue = (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>;

// Threads per job: a folder that has more waits for the next tick (15 min).
const PER_MAILBOX = 200;

export async function runExpiryTick({ now, enqueue }: { now: Date; enqueue: Enqueue }) {
	// 1. Idempotent cleanup: an expiry outside an archive folder (row moved by a path that does
	//    not go through moveMail) or on a thread back in the Inbox will never make anything leave.
	const cleared = await db.execute(sql`
		update mailbox_threads mt set expires_at = null, updated_at = now()
		where mt.expires_at is not null
		  and (not exists (select 1 from mailboxes mb where mb.id = mt.mailbox_id and mb.kind = 'archive') or ${inboxSister})
		returning mt.thread_id
	`);

	// 2. and 3. One job per archive folder that has due threads. The tick never writes the expiry
	//    of a due thread: the move clears it. jobId stable within the hour: BullMQ does not add a
	//    second job while the first one waits (smtp-worker, one job at a time).
	const boxes = (await db.execute(sql`
		select distinct mt.mailbox_id from mailbox_threads mt
		join mailboxes mb on mb.id = mt.mailbox_id and mb.kind = 'archive'
		where ${due(now)}
	`)) as any[];
	let jobs = 0;
	for (const b of boxes) {
		const mailboxId = String(b.mailbox_id);
		const ids = (await dueExpiredThreads(db, { now, mailboxId, limit: PER_MAILBOX })).map((t) => t.threadId);
		if (!ids.length) continue;
		const [sync] = (await db.execute(sql`select 1 from mailbox_sync where mailbox_id = ${mailboxId}::uuid limit 1`)) as any[];
		await enqueue(
			"mail:move",
			{ threadId: ids[0], threadIds: ids, mailboxId, op: "trash", moveImap: !!sync, expiry: true },
			{
				jobId: `expire-${mailboxId}-${expiryBucket(now)}`,
				attempts: 8,
				backoff: { type: "exponential", delay: 5000 },
				removeOnComplete: true,
				removeOnFail: { age: 604800 },
			},
		);
		jobs++;
	}
	return { cleared: (cleared as any[]).length, jobs };
}
