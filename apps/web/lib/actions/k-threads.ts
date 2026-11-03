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
	const labelsByThreadId = mailboxThreads.length ? await fetchMailboxThreadLabels(mailboxThreads) : {};
	return { mailboxThreads, labelsByThreadId };
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
	const labelsByThreadId = threads.length ? await fetchMailboxThreadLabels(threads) : {};
	return { mailboxThreads: threads, labelsByThreadId };
}
