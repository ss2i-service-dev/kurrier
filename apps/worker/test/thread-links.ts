// Threads: a reply that arrived before its parent (IMAP catch-up from newest to oldest)
// joins the parent's thread when the parent arrives (lib/thread-links.ts, merge_threads of
// migration 007), sequentially and in parallel, without mixing two owners or creating a
// thread for a message already present. Test database: see mcp-test-env.ts for how to run it:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/thread-links.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxThreads, messages, threads } from "@db";
import { and, eq, inArray } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { storeMessageInThread } from "../lib/message-payload-parser";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

function raw(o: { id: string; subject: string; inReplyTo?: string; refs?: string[]; date: string }) {
	return [
		`From: Client <client@example.org>`,
		`To: me@test.invalid`,
		`Subject: ${o.subject}`,
		`Date: ${o.date}`,
		`Message-ID: ${o.id}`,
		o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}` : null,
		o.refs?.length ? `References: ${o.refs.join(" ")}` : null,
		``,
		`body ${o.id}`,
	].filter((l) => l !== null).join("\r\n");
}

async function ingest(f: Fixture, mailboxId: string, r: string, seen = false) {
	const parsed = await simpleParser(r);
	const decorated = {
		...parsed,
		createdAt: parsed.date,
		mailboxId,
		workspaceId: f.workspace.id,
		ownerId: f.user.id,
		headersJson: {},
		references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : null,
		seen,
		html: "",
		snippet: parsed.text?.slice(0, 100) ?? null,
	};
	const placed = await storeMessageInThread(parsed, decorated, { ownerId: f.user.id, workspaceId: f.workspace.id });
	return placed;
}

const threadsOf = async (ids: string[], ownerId: string) => {
	const rows = await db
		.select({ t: messages.threadId })
		.from(messages)
		.where(and(eq(messages.ownerId, ownerId), inArray(messages.messageId, ids)));
	return new Set(rows.map((r) => r.t));
};

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const tag = `${Date.now()}`;
	const id = (n: string) => `<${n}-${tag}@example.org>`;

	// 1. Catch-up from newest to oldest: C (reply to B), B (reply to A), A.
	const [A, B, C] = [id("a"), id("b"), id("c")];
	await ingest(a, a.inbox.id, raw({ id: C, subject: "Re: Re: agreement", inReplyTo: B, refs: [A, B], date: "Wed, 29 Oct 2026 10:00:00 +0000" }));
	await ingest(a, a.inbox.id, raw({ id: B, subject: "Re: agreement", inReplyTo: A, refs: [A], date: "Tue, 28 Oct 2026 10:00:00 +0000" }), true);
	const beforeParent = await threadsOf([B, C], a.user.id);
	assert(beforeParent.size === 1, "B arrives after C: C (its child) joins its thread");

	// Snooze set on the thread of C before the parent arrives.
	const [cRow] = await db.select().from(messages).where(and(eq(messages.ownerId, a.user.id), eq(messages.messageId, C)));
	const snooze = new Date(Date.now() + 86_400_000);
	await db.update(mailboxThreads).set({ snoozedUntil: snooze }).where(eq(mailboxThreads.threadId, cRow.threadId));

	const placedA = await ingest(a, a.inbox.id, raw({ id: A, subject: "agreement", date: "Mon, 27 Oct 2026 10:00:00 +0000" }));
	const all = await threadsOf([A, B, C], a.user.id);
	assert(all.size === 1, "A arrives last: A, B, C in a single thread");
	const target = [...all][0];
	assert(placedA?.merged === true && placedA.threadId === target, "storeMessageInThread reports the merge and the final thread");

	const mts = await db.select().from(mailboxThreads).where(eq(mailboxThreads.threadId, target));
	assert(mts.length === 1 && mts[0].messageCount === 3 && mts[0].unreadCount === 2, `one list row, 3 messages of which 2 unread (${JSON.stringify(mts.map((m) => [m.messageCount, m.unreadCount]))})`);
	assert(mts[0]?.subject === "Re: Re: agreement", "row subject = most recent message");
	assert(mts[0]?.snoozedUntil?.getTime() === snooze.getTime(), "snooze kept");
	const [t] = await db.select().from(threads).where(eq(threads.id, target));
	assert(t && new Date(t.lastMessageDate!).toISOString() === "2026-10-29T10:00:00.000Z", "threads.last_message_date = most recent");
	const orphans = await db
		.select({ id: threads.id })
		.from(threads)
		.where(and(eq(threads.ownerId, a.user.id)));
	assert(orphans.length === 2, `alice's threads: fixture + conversation, no source thread left (${orphans.length})`);

	// 2. Message already present: nothing is created.
	const again = await ingest(a, a.inbox.id, raw({ id: B, subject: "Re: agreement", inReplyTo: A, refs: [A], date: "Tue, 28 Oct 2026 10:00:00 +0000" }));
	const afterDup = await db.select({ id: threads.id }).from(threads).where(eq(threads.ownerId, a.user.id));
	assert(again === null && afterDup.length === 2, "duplicate: null and no empty thread");

	// 3. Copy of the same message in Sent: same thread, one row per folder.
	await ingest(a, a.sent.id, raw({ id: B, subject: "Re: agreement", inReplyTo: A, refs: [A], date: "Tue, 28 Oct 2026 10:00:00 +0000" }), true);
	assert((await threadsOf([A, B, C], a.user.id)).size === 1, "copy in Sent: same thread");
	const rowsAfterCopy = await db.select().from(mailboxThreads).where(eq(mailboxThreads.threadId, target));
	assert(rowsAfterCopy.length === 2, "two list rows (inbox, sent) for the thread");

	// 4. Isolation: bob receives the same Message-IDs, his threads stay his.
	await ingest(b, b.inbox.id, raw({ id: C, subject: "Re: Re: agreement", inReplyTo: B, refs: [A, B], date: "Wed, 29 Oct 2026 10:00:00 +0000" }));
	await ingest(b, b.inbox.id, raw({ id: A, subject: "agreement", date: "Mon, 27 Oct 2026 10:00:00 +0000" }));
	const bobThreads = await threadsOf([A, C], b.user.id);
	assert(bobThreads.size === 1 && !bobThreads.has(target), "bob: A and C (refs) in a thread of his own, never alice's");
	assert((await threadsOf([A, B, C], a.user.id)).size === 1, "alice: unchanged after bob");

	// 5. In parallel (catch-up with concurrency 2 + real time): parent and children at once.
	let ok = 0;
	const rounds = 15;
	for (let i = 0; i < rounds; i++) {
		const p = id(`p${i}`), r1 = id(`r${i}`), r2 = id(`s${i}`);
		await Promise.all([
			ingest(a, a.inbox.id, raw({ id: r2, subject: "Re: Re: x", inReplyTo: r1, refs: [p, r1], date: "Sat, 01 Nov 2026 12:00:00 +0000" })),
			ingest(a, a.inbox.id, raw({ id: p, subject: "x", date: "Sat, 01 Nov 2026 10:00:00 +0000" })),
			ingest(a, a.inbox.id, raw({ id: r1, subject: "Re: x", inReplyTo: p, refs: [p], date: "Sat, 01 Nov 2026 11:00:00 +0000" })),
		]);
		if ((await threadsOf([p, r1, r2], a.user.id)).size === 1) ok++;
	}
	assert(ok === rounds, `parallel: ${ok}/${rounds} conversations in a single thread`);
	const empty = await db.execute(
		`select count(*)::int n from threads t where t.owner_id = '${a.user.id}' and not exists (select 1 from messages m where m.thread_id = t.id)` as any,
	);
	assert(Number((empty as any)[0]?.n) === 0, "no empty thread after the parallel merges");

	// 6. Repair: the function refuses to merge two owners.
	const [bobThread] = [...bobThreads];
	let refused = false;
	try {
		await db.execute(`select public.merge_threads('${target}'::uuid, '{${bobThread}}'::uuid[])` as any);
	} catch {
		refused = true;
	}
	assert(refused, "merge_threads refuses two owners");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
