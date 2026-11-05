// Arrival UIDs of an IMAP move, found again by Message-ID. Pure functions, shared by the
// worker (moveMail) and tested without a database or IMAP.
//
// After a MOVE of several messages, Stalwart returns a COPYUID whose two sets do not
// match in order: copying the UID by position gave a message the UID of another one of
// the same batch, and the following read / unread / starred change hit the wrong message.
// The destination folder is therefore read again and messages are paired by Message-ID;
// when in doubt, no UID rather than a guessed UID.

export const normMessageId = (v?: string | null) =>
	String(v ?? "").trim().replace(/^<|>$/g, "").toLowerCase();

export type MovedRow = { id: string; messageId: string | null };
export type DestEnvelope = { uid: number; messageId: string | null };

// UIDs of `found` already held in the database by ANOTHER message of the destination folder
// carrying the same Message-ID (copy already present). A row whose Message-ID differs has a
// stale UID: it blocks nothing.
export function heldUids(found: DestEnvelope[], held: DestEnvelope[]): Set<number> {
	const midAt = new Map(found.map((f) => [Number(f.uid), normMessageId(f.messageId)]));
	const out = new Set<number>();
	for (const h of held) {
		const uid = Number(h.uid);
		if (midAt.has(uid) && midAt.get(uid) === normMessageId(h.messageId)) out.add(uid);
	}
	return out;
}

// `moved`: messages sent in the MOVE; `found`: envelopes of the destination folder that
// appeared since the MOVE (UID >= UIDNEXT from before), plus the verified COPYUID UIDs;
// `taken`: UIDs already assigned in the database (heldUids).
// - a single message for this Message-ID: the most recent UID among those not taken;
// - several messages of the batch with the same Message-ID: impossible to tell which is
//   which, no UID (ambiguous);
// - no Message-ID: only if there is exactly one candidate without a Message-ID;
// - no candidate: the message did not arrive (missing), to be checked in the source.
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

// deltaFetch cursor (mailbox_sync.last_seen_uid) of the destination folder: without it, the
// next sync reads the whole batch again (full source of each message) and, if another message
// carries the same Message-ID, may "detect a move" of the wrong thread. It is set only once,
// at the end of the operation (compare-and-set from the value read before the MOVE), and only
// if nothing was waiting above (l0 >= UIDNEXT - 1): otherwise deltaFetch is behind, leave it alone.
export const cursorAtTop = (l0: number, u0: number) => u0 > 0 && l0 >= u0 - 1;

// Arrived UIDs to count as known to the database for the cursor: those already held or copied
// (`alsoKnown`), and any UID whose Message-ID belongs to the batch, ambiguous ones and
// duplicates included (otherwise the cursor would drop below the batch and deltaFetch would
// read it again). The empty Message-ID counts only if the batch itself has a message without
// a Message-ID (deltaFetch would create a duplicate on every read).
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

// At the end of a batch (if cursorAtTop): `arrived` = UIDs >= u0 present in the folder, `known`
// per knownArrivals. All known: cursor on the last real UID (never beyond it, a UID not yet
// assigned would be skipped). Otherwise just below the first unknown one, so that deltaFetch
// syncs it. A loop rather than Math.max(...): a batch of tens of thousands of UIDs would
// exceed the argument limit.
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

// The IMAP MOVE does not depend on what the page loaded: a folder synced over IMAP
// (mailbox_sync row) is always moved on the server. A page without this state (search,
// labels) could send moveImap=false, a "database only" trash, and the database and IMAP
// would diverge (messages deleted in the app but left in the IMAP INBOX).
export const shouldMoveImap = (requested: boolean | undefined, sourceSynced: boolean) =>
	Boolean(requested) || sourceSynced;
