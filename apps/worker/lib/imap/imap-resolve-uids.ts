import type { ImapFlow } from "imapflow";

export type UidRow = { id: string; uid: number; messageId: string | null };

const norm = (v?: string | null) =>
	(v ?? "").trim().replace(/^<|>$/g, "").toLowerCase();

/**
 * The UID kept in the database is not reliable. A move changes the message's UID (it gets
 * a new one in the destination folder) while the database kept the old one; same when the
 * sync "detects a move" (Gmail labels: the same message is listed in two folders). Acting
 * on that UID would then touch ANOTHER message of the folder, or none.
 *
 * Before a move or a deletion, check that the UID designates the expected message
 * (Message-ID); otherwise look it up by Message-ID in the folder, and if it is not there
 * touch nothing.
 *
 * The lookup first goes through SEARCH HEADER (Gmail answers it well); Stalwart returns
 * nothing on that header, hence the fallback to reading the folder's envelopes, bounded to
 * folders of reasonable size.
 *
 * Call with the folder lock held. Returns real UID -> id of the `messages` row.
 */
const SCAN_LIMIT = 5000;

export async function resolveUids(
	client: ImapFlow,
	rows: UidRow[],
): Promise<Map<number, string>> {
	const resolved = new Map<number, string>();

	// Folder envelopes, read once and only if SEARCH returned nothing.
	let scanned: Map<string, number[]> | undefined;
	const scan = async () => {
		if (scanned) return scanned;
		scanned = new Map();
		const box = client.mailbox;
		const exists = box && typeof box === "object" ? Number(box.exists ?? 0) : 0;
		if (!exists || exists > SCAN_LIMIT) return scanned;
		for await (const m of client.fetch("1:*", { uid: true, envelope: true })) {
			const key = norm(m.envelope?.messageId);
			if (!key) continue;
			scanned.set(key, [...(scanned.get(key) ?? []), m.uid]);
		}
		return scanned;
	};

	// Envelopes of the UIDs held in the database, in ONE FETCH: a selection of 50 threads used
	// to make 50 round trips (several seconds on Gmail) before moving anything.
	const atUid = new Map<number, string>();
	const uidList = [...new Set(rows.map((r) => Number(r.uid)).filter((u) => u > 0))];
	if (uidList.length) {
		try {
			for await (const m of client.fetch(uidList.join(","), { uid: true, envelope: true }, { uid: true })) {
				atUid.set(Number(m.uid), norm(m.envelope?.messageId));
			}
		} catch {
			// per-message check below
		}
	}

	for (const row of rows) {
		const wanted = norm(row.messageId);
		// Without a Message-ID in the database there is nothing to compare: original behaviour.
		if (!wanted) {
			resolved.set(row.uid, row.id);
			continue;
		}

		if (atUid.get(Number(row.uid)) === wanted) {
			resolved.set(row.uid, row.id);
			continue;
		}

		const found = await client
			.search(
				{ header: { "message-id": String(row.messageId).trim() } },
				{ uid: true },
			)
			.catch(() => false as const);
		let uids: number[] = Array.isArray(found) ? found : [];
		if (!uids.length) {
			uids = (await scan().catch(() => undefined))?.get(wanted) ?? [];
		}
		if (!uids.length) {
			console.warn(
				`[imap:resolve-uids] message ${row.id} not found in the folder (database uid ${row.uid}), skipped`,
			);
			continue;
		}
		for (const uid of uids) resolved.set(Number(uid), row.id);
	}

	return resolved;
}
