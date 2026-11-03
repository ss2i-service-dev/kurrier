"use server";
// SS2i (Outlook) : pouls de la boite de reception, interroge toutes les 20 s par
// le navigateur pour signaler un nouveau message (son, pastille sur l'icone de
// l'onglet, liste actualisee). Une seule requete legere, sous RLS : nombre de
// fils non lus de l'Inbox et date du plus recent d'entre eux (elle avance a
// chaque message entrant, pas quand on envoie ou qu'on remet un fil en non lu).
import { and, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { mailboxes, mailboxThreads } from "@db";
import { rlsClient } from "@/lib/actions/clients";

export async function kInboxPulse(): Promise<{ unread: number; latest: string | null } | null> {
	try {
		const rls = await rlsClient();
		const now = new Date();
		const [row] = await rls((tx) =>
			tx
				.select({
					unread: count(),
					latest: sql<string | null>`max(${mailboxThreads.lastActivityAt})`,
				})
				.from(mailboxThreads)
				.where(
					and(
						// Par boite (index ix_mbth_mailbox_unread sur mailbox_id, unread_count) :
						// seules les lignes non lues sont lues, quelle que soit la taille de l'Inbox.
						inArray(
							mailboxThreads.mailboxId,
							tx.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.slug, "inbox")),
						),
						gt(mailboxThreads.unreadCount, 0),
						or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
					),
				),
		);
		const latest = row?.latest ? new Date(row.latest as any).toISOString() : null;
		return { unread: Number(row?.unread ?? 0), latest };
	} catch {
		return null;
	}
}
