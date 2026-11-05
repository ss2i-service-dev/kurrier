// ss2i (OI 10286) : UID d'arrivee d'un deplacement IMAP, retrouves par Message-ID. Fonctions
// pures, partagees par le worker (moveMail) et testees sans base ni IMAP.
//
// Apres un MOVE de plusieurs messages, Stalwart rend un COPYUID dont les deux ensembles ne se
// correspondent pas dans l'ordre (99 % des messages de l'archivage du 04/11 a realigner) :
// recopier l'UID par position donnait a un message l'UID d'un autre du meme lot, et le lu /
// non lu / etoile suivant touchait le mauvais message. On relit donc le dossier d'arrivee et
// on apparie par Message-ID ; dans le doute, pas d'UID plutot qu'un UID devine.

export const normMessageId = (v?: string | null) =>
	String(v ?? "").trim().replace(/^<|>$/g, "").toLowerCase();

export type MovedRow = { id: string; messageId: string | null };
export type DestEnvelope = { uid: number; messageId: string | null };

// UID de `found` deja tenus en base par un AUTRE message du dossier d'arrivee portant le meme
// Message-ID (copie deja presente). Une ligne dont le Message-ID differe a un UID perime : elle
// ne bloque rien.
export function heldUids(found: DestEnvelope[], held: DestEnvelope[]): Set<number> {
	const midAt = new Map(found.map((f) => [Number(f.uid), normMessageId(f.messageId)]));
	const out = new Set<number>();
	for (const h of held) {
		const uid = Number(h.uid);
		if (midAt.has(uid) && midAt.get(uid) === normMessageId(h.messageId)) out.add(uid);
	}
	return out;
}

// `moved` : messages envoyes dans le MOVE ; `found` : enveloppes du dossier d'arrivee apparues
// depuis le MOVE (UID >= UIDNEXT d'avant), plus les UID du COPYUID verifies ; `taken` : UID
// deja attribues en base (heldUids).
// - un seul message pour ce Message-ID : l'UID le plus recent parmi ceux qui ne sont pas pris ;
// - plusieurs messages du lot avec le meme Message-ID : impossible de savoir lequel est lequel,
//   aucun UID (ambiguous) ;
// - sans Message-ID : seulement s'il y a exactement un candidat sans Message-ID ;
// - aucun candidat : le message n'est pas arrive (missing), a verifier dans la source.
export function matchMovedUids(
	moved: MovedRow[],
	found: DestEnvelope[],
	taken: Iterable<number> = [],
) {
	const takenSet = new Set([...taken].map(Number));
	const uidsByMid = new Map<string, number[]>();
	for (const f of found) {
		const uid = Number(f.uid);
		if (!(uid > 0) || takenSet.has(uid)) continue;
		const k = normMessageId(f.messageId);
		const list = uidsByMid.get(k) ?? [];
		if (!list.includes(uid)) list.push(uid);
		uidsByMid.set(k, list);
	}

	const rowsByMid = new Map<string, MovedRow[]>();
	for (const r of moved) {
		const k = normMessageId(r.messageId);
		rowsByMid.set(k, [...(rowsByMid.get(k) ?? []), r]);
	}

	const assigned = new Map<string, number>();
	const ambiguous: string[] = [];
	const missing: string[] = [];
	for (const [k, rows] of rowsByMid) {
		const candidates = (uidsByMid.get(k) ?? []).sort((a, b) => b - a);
		const ids = rows.map((r) => r.id);
		if (!candidates.length) missing.push(...ids);
		else if (rows.length > 1 || (!k && candidates.length > 1)) ambiguous.push(...ids);
		else assigned.set(rows[0].id, candidates[0]);
	}
	return { assigned, ambiguous, missing };
}

// Curseur deltaFetch (mailbox_sync.last_seen_uid) du dossier d'arrivee, avance AVANT le MOVE
// sur les UID que le lot va occuper : une synchronisation lancee entre le MOVE et la recopie
// des UID relirait sinon tout le lot (source complete de chaque message) et, si un autre
// message porte le meme Message-ID (copie des Envoyes), « detecterait un deplacement » du
// mauvais fil. Seulement si rien n'attend au-dessus du curseur (l0 >= UIDNEXT - 1) : sinon
// deltaFetch est en retard et on ne touche a rien. Rend la cible, ou null.
export function destCursorBeforeMove(l0: number, u0: number, n: number): number | null {
	if (!(u0 > 0) || l0 < u0 - 1) return null;
	return Math.max(l0, u0 - 1 + Math.max(0, n));
}

// Apres le lot (si le curseur a ete avance avant) : `arrived` = UID >= u0 presents dans le
// dossier, `known` quand la base tient ce message (meme UID, meme Message-ID). Tout est connu :
// curseur sur le dernier UID reel (jamais au-dela, un UID non encore attribue serait saute).
// Sinon juste sous le premier inconnu, pour que deltaFetch le synchronise.
export function destCursorAfterMove(
	u0: number,
	arrived: Array<{ uid: number; known: boolean }>,
): number {
	const fresh = arrived.filter((a) => Number(a.uid) >= u0);
	const unknown = fresh.filter((a) => !a.known).map((a) => Number(a.uid));
	if (unknown.length) return Math.min(...unknown) - 1;
	return Math.max(u0 - 1, ...fresh.map((a) => Number(a.uid)));
}

// Le MOVE IMAP ne depend pas de ce que la page a charge : un dossier synchronise en IMAP
// (ligne mailbox_sync) est toujours deplace sur le serveur. Une page sans cet etat (recherche,
// libelles, vue Clients) envoyait moveImap=false : corbeille « base seule », base et IMAP
// divergeaient (~3 080 messages supprimes dans courrier mais restes dans l'INBOX IMAP).
export const shouldMoveImap = (requested: boolean | undefined, sourceSynced: boolean) =>
	Boolean(requested) || sourceSynced;
