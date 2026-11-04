"use server";
// SS2i (Outlook) : page suivante de la liste des fils, pour le chargement au
// defilement. Memes requetes que la page serveur (RLS via fetchMailboxThreads).
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
 * SS2i (Outlook) : filtre « Non lus » cote serveur, page par page. Le filtre
 * applique dans le navigateur sur les pages deja chargees obligeait a charger
 * toute la boite pour trouver quelques non-lus (chargement sans fin en bas).
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
 * SS2i (Outlook) : fils qui ont une vraie piece jointe. has_attachments (calcule
 * par le worker) compte aussi les images integrees au corps (signatures, logos) :
 * la liste affichait un trombone pour une simple signature. Ne comptent pas :
 * les pieces marquees inline et les images referencees dans le corps (cid).
 */
// ss2i (controle d'acces) : helper serveur, plus exporte (tout export d'un fichier "use server" est une action appelable).
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

/** Variante pour une liste de fils deja chargee (seuls ceux marques has_attachments). */
export async function kRealAttachmentsOf(threads: { threadId: unknown; hasAttachments?: boolean | null }[]) {
	return fetchKRealAttachmentThreads(threads.filter((t) => t.hasAttachments).map((t) => String(t.threadId)));
}
