import { sql } from "drizzle-orm";
import {
	CLEANUP_ALLOWED_KINDS,
	CLEANUP_MAX_DAYS,
	CLEANUP_MIN_DAYS,
	cleanupCutoff,
	type CleanupRow,
	type CleanupScope,
} from "./cleanup-rules";

// ss2i : nettoyage automatique, eligibilite d'un fil (docs/plans/nettoyage-auto-recherche.md, MT3).
// Typesense ne fournit que des candidats (threadIds) : ce SQL decide, au compte a la creation, au tick
// et dans la transaction du move. Une ligne mailbox_threads du scope part si son fil est vieux, c'est-a-
// dire si aucun de ses messages, dans aucun dossier (Envoyes et Brouillons compris : une reponse ou un
// brouillon recent retient le fil), n'a une date apres la date limite, et si aucune ligne du fil dans
// l'identite n'est etoilee, recente ou reportee. Un report compte comme une activite : la ligne reste
// recente jusqu'a la duree apres snoozed_until, ou apres unsnoozed_at quand le report est leve (le fil
// revient alors en tete de liste).
// Une ligne dont un message a son jumeau (meme message_id) dans un dossier Envoyes de l'identite ne part
// jamais : sur Gmail, l'archive est « Tous les messages » (\All, discover-mailboxes.ts), qui liste aussi
// les Envoyes (imap-delta-fetch.ts y cree la ligne d'un envoi pas encore connu), et un MOVE vers la
// Corbeille retire tous les libelles, Envoyes compris ; meme chose pour un envoi a soi-meme en Inbox. Les
// dossiers Envoyes sont lus une fois (array), le jumeau par uniq_mailbox_message_id (mailbox_id, message_id).
// L'age d'un message est messages.date seul : depuis d7d0ac62, a la reception (IMAP, Stalwart), elle vaut
// la date interne IMAP, heure d'arrivee sur le serveur, que l'expediteur ne peut pas antidater
// (parseAndStoreEmail). Avant, elle venait de l'en-tete Date (ou de l'heure d'ingestion) : un en-tete
// antidate sur ces lignes ne peut que faire partir plus tot des messages qui ont deja plus de 53 jours.
// created_at n'est pas lu : avant d7d0ac62 il valait l'heure d'ingestion et retiendrait a tort tout le
// courrier importe ; il ne sert qu'a un message sans date. Une date dans le futur retient le fil.
// forUpdate (transaction du move) : apres l'attente d'un verrou, Postgres ne relit que la ligne
// verrouillee, les sous-requetes gardent la photo de l'instruction ; l'age, l'etoile et le report sont
// donc aussi ecrits directement sur mt (meme raisonnement que dueExpiredThreads). Le jumeau en Envoyes
// garde la photo de l'instruction : un jumeau commite pendant l'attente du verrou n'est pas vu, comme un
// jumeau pas encore ingere (Envoyes synchronise apres l'archive).

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
	// mailboxId vide ou invalide ne doit pas elargir la portee a tous les dossiers.
	if (o.mailboxId !== undefined && !isUuid(o.mailboxId)) return [];
	const days = scope.retentionDays;
	if (!Number.isInteger(days) || days < CLEANUP_MIN_DAYS || days > CLEANUP_MAX_DAYS) return [];
	const boxIds = scope.mailboxIds.filter((id) => isUuid(id) && (!o.mailboxId || id === o.mailboxId));
	if (!threadIds.length || !boxIds.length || !isUuid(scope.identityId)) return [];
	const cutoff = cleanupCutoff(o.now, days).toISOString();
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
		  and greatest(mt.last_activity_at, mt.unsnoozed_at, mt.snoozed_until) <= ${cutoff}::timestamptz
		  and not mt.starred
		  and (mt.snoozed_until is null or mt.snoozed_until <= ${now}::timestamptz)
		  ${scope.onlyUnread ? sql`and mt.unread_count > 0` : sql``}
		  ${scope.hasAttachment ? sql`and mt.has_attachments` : sql``}
		  and not exists (
			select 1 from mailbox_threads s
			where s.thread_id = mt.thread_id and s.identity_id = mt.identity_id
			  and (s.starred or greatest(s.last_activity_at, s.unsnoozed_at, s.snoozed_until) > ${cutoff}::timestamptz)
		  )
		  and not exists (
			select 1 from messages m
			where m.thread_id = mt.thread_id and coalesce(m.date, m.created_at) > ${cutoff}::timestamptz
		  )
		  and not exists (
			select 1 from messages m
			join messages s on s.message_id = m.message_id
			where m.thread_id = mt.thread_id and m.mailbox_id = mt.mailbox_id
			  and s.mailbox_id = any(array(
				select sb.id from mailboxes sb where sb.identity_id = ${scope.identityId}::uuid and sb.kind = 'sent'
			  ))
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
