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

// Curseur deltaFetch (mailbox_sync.last_seen_uid) du dossier d'arrivee : sans lui, la synchro
// suivante relit tout le lot (source complete de chaque message) et, si un autre message porte
// le meme Message-ID, peut « detecter un deplacement » du mauvais fil. Il n'est pose qu'une fois,
// en fin d'operation (compare-and-set depuis la valeur lue avant le MOVE), et seulement si rien
// n'attendait au-dessus (l0 >= UIDNEXT - 1) : sinon deltaFetch est en retard, on n'y touche pas.
export const cursorAtTop = (l0: number, u0: number) => u0 > 0 && l0 >= u0 - 1;

// UID arrives a compter comme connus de la base pour le curseur : ceux deja tenus ou recopies
// (`alsoKnown`), et tout UID dont le Message-ID appartient au lot, ambigus et doublons compris
// (sinon le curseur redescendrait sous le lot et deltaFetch le relirait). Le Message-ID vide
// n'en est que si le lot a lui-meme un message sans Message-ID (deltaFetch en creerait un
// double a chaque lecture).
export function knownArrivals(
	found: DestEnvelope[],
	lotMessageIds: Array<string | null>,
	alsoKnown: Iterable<number> = [],
): Set<number> {
	const lot = new Set(lotMessageIds.map(normMessageId));
	const out = new Set([...alsoKnown].map(Number));
	for (const f of found) if (lot.has(normMessageId(f.messageId))) out.add(Number(f.uid));
	return out;
}

// En fin de lot (si cursorAtTop) : `arrived` = UID >= u0 presents dans le dossier, `known`
// d'apres knownArrivals. Tout est connu : curseur sur le dernier UID reel (jamais au-dela, un UID
// non encore attribue serait saute). Sinon juste sous le premier inconnu, pour que deltaFetch le
// synchronise. Boucle plutot que Math.max(...) : un lot de plusieurs dizaines de milliers d'UID
// depasserait la limite d'arguments.
export function destCursorAfterMove(
	u0: number,
	arrived: Array<{ uid: number; known: boolean }>,
): number {
	let top = u0 - 1;
	let firstUnknown = Infinity;
	for (const a of arrived) {
		const uid = Number(a.uid);
		if (uid < u0) continue;
		if (uid > top) top = uid;
		if (!a.known && uid < firstUnknown) firstUnknown = uid;
	}
	return firstUnknown === Infinity ? top : firstUnknown - 1;
}

// Le MOVE IMAP ne depend pas de ce que la page a charge : un dossier synchronise en IMAP
// (ligne mailbox_sync) est toujours deplace sur le serveur. Une page sans cet etat (recherche,
// libelles, vue Clients) envoyait moveImap=false : corbeille « base seule », base et IMAP
// divergeaient (~3 080 messages supprimes dans courrier mais restes dans l'INBOX IMAP).
export const shouldMoveImap = (requested: boolean | undefined, sourceSynced: boolean) =>
	Boolean(requested) || sourceSynced;
