"use server";
// Next page of the thread list, for scroll loading. Same queries as the server page (RLS via
// fetchMailboxThreads).
import { fetchMailboxThreads } from "@/lib/actions/mailbox";
import { fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { mailboxThreads } from "@db";
import { PAGE_SIZE } from "@common/mail-client";
import { rlsClient } from "@/lib/actions/clients";

export async function fetchKThreadPage(identityPublicId: string, mailboxSlug: string, page: number) {
	const mailboxThreads = await fetchMailboxThreads(identityPublicId, mailboxSlug, page);
	const [labelsByThreadId, realAttachments] = mailboxThreads.length
		? await Promise.all([fetchMailboxThreadLabels(mailboxThreads), kRealAttachmentsOf(mailboxThreads)])
		: [{}, [] as string[]];
	return { mailboxThreads, labelsByThreadId, realAttachments };
}

/**
 * Server-side "Unread" filter, page by page. A filter applied in the browser to the pages
 * already loaded forced loading the whole mailbox to find a few unread threads (endless
 * loading at the bottom).
 */
export async function fetchKUnreadPage(identityPublicId: string, mailboxSlug: string, page: number) {
	const rls = await rlsClient();
	const now = new Date();
	const safePage = page && page > 0 ? page : 1;
	const effectiveActivityAt = sql`COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt})`;
	const rows = await rls((tx) =>
		tx
			.select({ thread: mailboxThreads })
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.identityPublicId, identityPublicId),
					eq(mailboxThreads.mailboxSlug, mailboxSlug),
					gt(mailboxThreads.unreadCount, 0),
					or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
				),
			)
			.orderBy(desc(effectiveActivityAt), desc(mailboxThreads.lastActivityAt), desc(mailboxThreads.threadId))
			.offset((safePage - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE),
	);
	const threads = rows.map((r) => r.thread) as unknown as Awaited<ReturnType<typeof fetchMailboxThreads>>;
	const [labelsByThreadId, realAttachments] = threads.length
		? await Promise.all([fetchMailboxThreadLabels(threads), kRealAttachmentsOf(threads)])
		: [{}, [] as string[]];
	return { mailboxThreads: threads, labelsByThreadId, realAttachments };
}

/**
 * Threads that have a real attachment. has_attachments (computed by the worker) also
 * counts images embedded in the body (signatures, logos): the list showed a paperclip for
 * a mere signature. Not counted: parts marked inline and images referenced in the body
 * (cid).
 */
// Server helper, not exported (any export of a "use server" file is a callable action).
async function fetchKRealAttachmentThreads(threadIds: string[]): Promise<string[]> {
	const ids = Array.from(new Set(threadIds.map(String))).filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 300);
	if (!ids.length) return [];
	const rls = await rlsClient();
	const res: any = await rls((tx) =>
		tx.execute(sql`
			select distinct m.thread_id as id
			from message_attachments a
			join messages m on m.id = a.message_id
			where m.thread_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
			  and not a.is_inline
			  and not (a.cid is not null and coalesce(a.content_type, '') ilike 'image/%')
		`),
	);
	return ((res?.rows ?? res ?? []) as any[]).map((r) => String(r.id));
}

/** Variant for an already loaded list of threads (only those marked has_attachments). */
export async function kRealAttachmentsOf(threads: { threadId: unknown; hasAttachments?: boolean | null }[]) {
	return fetchKRealAttachmentThreads(threads.filter((t) => t.hasAttachments).map((t) => String(t.threadId)));
}
