import { sql } from "drizzle-orm";
import { CLEANUP_ALLOWED_KINDS, cleanupCutoff, type CleanupRow, type CleanupScope } from "./cleanup-rules";

// ss2i : nettoyage automatique, eligibilite d'un fil (docs/plans/nettoyage-auto-recherche.md, MT3).
// Typesense ne fournit que des candidats (threadIds) : ce SQL decide, au compte a la creation, au tick
// et dans la transaction du move. Une ligne mailbox_threads du scope part si son fil est vieux, c'est-a-
// dire si aucun de ses messages, dans aucun dossier (Envoyes et Brouillons compris : une reponse ou un
// brouillon recent retient le fil), n'a une date apres la date limite, et si aucune ligne du fil dans
// l'identite n'est etoilee, recente ou reportee.
// L'age d'un message est messages.date seul : a la reception (IMAP, Stalwart), elle vaut la date interne
// IMAP, heure d'arrivee sur le serveur, que l'expediteur ne peut pas antidater (parseAndStoreEmail).
// created_at n'est pas lu : avant d7d0ac62 il valait l'heure d'ingestion et retiendrait a tort tout le
// courrier importe ; il ne sert qu'a un message sans date. Une date dans le futur retient le fil.
// forUpdate (transaction du move) : apres l'attente d'un verrou, Postgres ne relit que la ligne
// verrouillee, les sous-requetes gardent la photo de l'instruction ; l'age, l'etoile et le report sont
// donc aussi ecrits directement sur mt (meme raisonnement que dueExpiredThreads).

type Dbh = { execute: (q: any) => Promise<any> };

export type CleanupEligibleScope = Pick<CleanupScope, "identityId" | "mailboxIds" | "hasAttachment" | "onlyUnread" | "retentionDays">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const kinds = `{${CLEANUP_ALLOWED_KINDS.join(",")}}`;

export async function eligibleCleanupThreads(
	dbh: Dbh,
	scope: CleanupEligibleScope,
	o: { now: Date; threadIds: string[]; mailboxId?: string; forUpdate?: boolean },
): Promise<CleanupRow[]> {
	// Identifiants venus de l'index : un seul invalide ferait echouer le cast de tout le lot.
	const threadIds = [...new Set(o.threadIds.filter(isUuid))];
	const boxIds = scope.mailboxIds.filter((id) => isUuid(id) && (!o.mailboxId || id === o.mailboxId));
	if (!threadIds.length || !boxIds.length || !isUuid(scope.identityId)) return [];
	const cutoff = cleanupCutoff(o.now, scope.retentionDays).toISOString();
	const now = o.now.toISOString();
	const rows = await dbh.execute(sql`
		select mt.thread_id, mt.mailbox_id, mt.expires_at
		from mailbox_threads mt
		where mt.identity_id = ${scope.identityId}::uuid
		  and mt.mailbox_id = any(${`{${boxIds.join(",")}}`}::uuid[])
		  and mt.thread_id = any(${`{${threadIds.join(",")}}`}::uuid[])
		  and exists (
			select 1 from mailboxes mb
			where mb.id = mt.mailbox_id and mb.identity_id = mt.identity_id and mb.kind::text = any(${kinds}::text[])
		  )
		  and mt.last_activity_at <= ${cutoff}::timestamptz
		  and not mt.starred
		  and (mt.snoozed_until is null or mt.snoozed_until <= ${now}::timestamptz)
		  ${scope.onlyUnread ? sql`and mt.unread_count > 0` : sql``}
		  ${scope.hasAttachment ? sql`and mt.has_attachments` : sql``}
		  and not exists (
			select 1 from mailbox_threads s
			where s.thread_id = mt.thread_id and s.identity_id = mt.identity_id
			  and (s.starred or s.last_activity_at > ${cutoff}::timestamptz or s.snoozed_until > ${now}::timestamptz)
		  )
		  and not exists (
			select 1 from messages m
			where m.thread_id = mt.thread_id and coalesce(m.date, m.created_at) > ${cutoff}::timestamptz
		  )
		order by mt.last_activity_at, mt.thread_id
		${o.forUpdate ? sql`for update of mt` : sql``}
	`);
	return (rows as any[]).map((r) => ({
		threadId: String(r.thread_id),
		mailboxId: String(r.mailbox_id),
		expiresAt: r.expires_at ? new Date(r.expires_at) : null,
	}));
}
