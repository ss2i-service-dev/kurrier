import { messages, threads } from "@db";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

// ss2i fils : le parseur amont ne cherchait qu'un PARENT deja en base. Le rattrapage IMAP
// importe du plus recent au plus ancien : chaque reponse arrivait avant son parent et creait
// son fil, et rien ne la rattachait quand le parent arrivait (une conversation de 6 messages
// en 6 fils). A l'arrivee d'un message, on cherche aussi les messages du meme proprietaire qui
// le citent (In-Reply-To ou References), ses autres copies (meme Message-ID dans un autre
// dossier) et tous ses parents connus, puis on fusionne leurs fils par ss2i_merge_threads
// (migration 008, partagee avec la reparation). Invariant entretenu : un message et ses liens
// presents partagent un fil, donc fusionner a chaque arrivee suffit (pas de fermeture
// transitive a calculer).

/**
 * Verrou par proprietaire, pris par parseAndStoreEmail (choix du fil, insertion, fusion) et par
 * le script de reparation : deux messages lies traites en parallele (rattrapage en concurrence 2,
 * synchro temps reel) ne peuvent pas creer chacun leur fil sans se voir.
 */
export async function lockOwnerThreads(tx: any, ownerId: string) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${"ss2i-threads:" + ownerId}, 0))`,
	);
}

/**
 * Fusionne dans un seul fil le fil du message qui vient d'etre insere et ceux des messages lies.
 * Cible : le fil du parent si le message en a trouve un (il y est deja), sinon le plus ancien des
 * fils lies (le fil neuf du message, vide d'autre chose, y est verse). Renvoie le fil final.
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

	// Litteral de tableau : drizzle developperait un tableau JS en liste de parametres.
	const res = await tx.execute(
		sql`select public.ss2i_merge_threads(${target}::uuid, ${`{${sources.join(",")}}`}::uuid[]) as moved`,
	);
	const moved = Number((res as any).rows?.[0]?.moved ?? (res as any)[0]?.moved ?? 0);
	if (moved < 0) throw new Error(`[thread-links] cible ${target} introuvable sous verrou`);
	// ss2i (archive-duree-de-vie) : un fil fusionne recoit des messages que l'utilisateur n'a pas
	// voulu faire expirer : echeance annulee (le fil est conserve).
	await tx.execute(sql`update mailbox_threads set expires_at = null where thread_id = ${target}::uuid and expires_at is not null`);
	return { threadId: target, merged: true };
}
