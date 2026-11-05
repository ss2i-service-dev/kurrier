import { messages, threads } from "@db";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

// Thread grouping: a plain parser only looks for a PARENT already in the database.
// The IMAP backfill imports from newest to oldest: each reply arrives before its parent and
// creates its own thread, and nothing links it when the parent arrives (a conversation of 6
// messages in 6 threads). When a message arrives, we also look for the owner's messages
// that quote it (In-Reply-To or References), its other copies (same Message-ID in another
// folder) and all its known parents, then merge their threads with merge_threads (migration
// 008, shared with the repair script). Maintained invariant: a message and its existing links
// share a thread, so merging on each arrival is enough (no transitive closure to compute).

/**
 * Per-owner lock, taken by parseAndStoreEmail (thread choice, insert, merge) and by the
 * repair script: two linked messages processed in parallel (backfill with concurrency 2,
 * realtime sync) cannot each create their own thread without seeing each other.
 */
export async function lockOwnerThreads(tx: any, ownerId: string) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${"kurrier-threads:" + ownerId}, 0))`,
	);
}

/**
 * Merges into a single thread the thread of the message just inserted and those of the
 * linked messages. Target: the parent's thread if the message found one (it is already
 * there), otherwise the oldest of the linked threads (the message's own new thread, empty of
 * anything else, is poured into it). Returns the final thread.
 */
export async function mergeLinkedThreads(
	tx: any,
	opts: {
		ownerId: string;
		messageId: string;
		candidates: string[];
		threadId: string;
		foundParent: boolean;
	},
): Promise<{ threadId: string; merged: boolean }> {
	const { ownerId, messageId, candidates, threadId, foundParent } = opts;

	const links = [
		eq(messages.messageId, messageId),
		eq(messages.inReplyTo, messageId),
		sql`${messages.references} @> array[${messageId}]::text[]`,
	];
	if (candidates.length) links.push(inArray(messages.messageId, candidates));

	const rows = await tx
		.selectDistinct({ threadId: messages.threadId, createdAt: threads.createdAt })
		.from(messages)
		.innerJoin(threads, eq(threads.id, messages.threadId))
		.where(and(eq(messages.ownerId, ownerId), ne(messages.threadId, threadId), or(...links)));

	if (!rows.length) return { threadId, merged: false };

	let target = threadId;
	let sources: string[] = rows.map((r: any) => r.threadId);
	if (!foundParent) {
		rows.sort(
			(a: any, b: any) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
				String(a.threadId).localeCompare(String(b.threadId)),
		);
		target = rows[0].threadId;
		sources = [...rows.slice(1).map((r: any) => r.threadId), threadId];
	}

	// Array literal: drizzle would expand a JS array into a list of parameters.
	const res = await tx.execute(
		sql`select public.merge_threads(${target}::uuid, ${`{${sources.join(",")}}`}::uuid[]) as moved`,
	);
	const moved = Number((res as any).rows?.[0]?.moved ?? (res as any)[0]?.moved ?? 0);
	if (moved < 0) throw new Error(`[thread-links] target ${target} not found under lock`);
	return { threadId: target, merged: true };
}
