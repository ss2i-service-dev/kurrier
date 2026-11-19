import { db } from "@db";
import { expiryBucket } from "@common";
import { sql } from "drizzle-orm";

// ss2i : archiver avec une duree de vie (docs/plans/archive-duree-de-vie.md). L'echeance vit sur
// la ligne mailbox_threads du fil dans le dossier archive (expires_at, migration ss2i_011). Le
// tick mail:expire-tick (common-worker, toutes les 15 min) poste un job mail:move op trash
// `expiry: true` par dossier ; moveMail revérifie l'echeance au debut du job puis sous verrou
// (dueExpiredThreads), le tick n'a donc rien a garantir sur la fenetre entre les deux. Jamais de
// suppression definitive : le fil part a la Corbeille par le chemin habituel.

type Dbh = { execute: (q: any) => Promise<any> };

export type DueThread = { threadId: string; mailboxId: string; identityId: string; expiresAt: Date };

// Une ligne du meme fil et de la meme identite dans la boite de reception annule l'echeance : le
// fil est revenu (reponse recue, desarchivage partiel).
const inboxSister = sql`exists (
	select 1 from mailbox_threads s join mailboxes sb on sb.id = s.mailbox_id
	where s.thread_id = mt.thread_id and s.identity_id = mt.identity_id and sb.kind = 'inbox'
)`;

const due = (now: Date) => sql`mt.expires_at is not null
	and mt.expires_at <= ${now.toISOString()}::timestamptz
	and not mt.starred
	and not ${inboxSister}`;

// Fils dus d'un dossier archive : echeance passee, non etoiles, sans ligne Inbox soeur.
// forUpdate (dans la transaction du move) : lignes verrouillees, et relues apres l'attente d'un
// verrou (READ COMMITTED) : une etoile posee entre-temps les exclut.
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

// Fils par job : un dossier qui en a plus attend le tick suivant (15 min).
const PER_MAILBOX = 200;

export async function runExpiryTick({ now, enqueue }: { now: Date; enqueue: Enqueue }) {
	// 1. Menage idempotent : une echeance hors dossier archive (ligne deplacee par un chemin qui ne
	//    passe pas par moveMail) ou sur un fil revenu dans l'Inbox ne fera jamais rien partir.
	const cleared = await db.execute(sql`
		update mailbox_threads mt set expires_at = null, updated_at = now()
		where mt.expires_at is not null
		  and (not exists (select 1 from mailboxes mb where mb.id = mt.mailbox_id and mb.kind = 'archive') or ${inboxSister})
		returning mt.thread_id
	`);

	// 2. et 3. Un job par dossier archive qui a des fils dus. Le tick n'ecrit jamais l'echeance
	//    d'un fil du : c'est le move qui la vide. jobId stable dans l'heure : BullMQ n'ajoute pas
	//    un second job tant que le premier attend (smtp-worker, un job a la fois).
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
