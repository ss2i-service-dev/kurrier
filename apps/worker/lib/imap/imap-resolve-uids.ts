import type { ImapFlow } from "imapflow";

export type UidRow = { id: string; uid: number; messageId: string | null };

const norm = (v?: string | null) =>
	(v ?? "").trim().replace(/^<|>$/g, "").toLowerCase();

/**
 * ss2i : l'UID garde en base n'est pas fiable. Un deplacement change l'UID du message
 * (il en recoit un nouveau dans le dossier d'arrivee) alors que la base gardait l'ancien ;
 * idem quand la synchronisation « detecte un deplacement » (libelles Gmail : le meme
 * message est liste dans deux dossiers). Agir sur cet UID touchait donc un AUTRE message
 * du dossier, ou aucun.
 *
 * Avant un deplacement ou une suppression, on verifie que l'UID designe bien le message
 * attendu (Message-ID) ; sinon on le recherche par Message-ID dans le dossier, et s'il
 * n'y est pas on ne touche a rien.
 *
 * La recherche passe d'abord par SEARCH HEADER (Gmail y repond bien) ; Stalwart ne rend
 * rien sur cet en-tete, d'ou le repli sur la lecture des enveloppes du dossier, borne aux
 * dossiers de taille raisonnable.
 *
 * A appeler verrou du dossier tenu. Retourne UID reel -> id de la ligne `messages`.
 */
const SCAN_LIMIT = 5000;

export async function resolveUids(
	client: ImapFlow,
	rows: UidRow[],
): Promise<Map<number, string>> {
	const resolved = new Map<number, string>();

	// Enveloppes du dossier, lues une seule fois et seulement si SEARCH n'a rien rendu.
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

	for (const row of rows) {
		const wanted = norm(row.messageId);
		// Sans Message-ID en base, rien a comparer : comportement d'origine.
		if (!wanted) {
			resolved.set(row.uid, row.id);
			continue;
		}

		const current = await client
			.fetchOne(String(row.uid), { envelope: true }, { uid: true })
			.catch(() => false as const);
		if (current && norm(current.envelope?.messageId) === wanted) {
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
				`[imap:resolve-uids] message ${row.id} introuvable dans le dossier (uid en base ${row.uid}), ignore`,
			);
			continue;
		}
		for (const uid of uids) resolved.set(Number(uid), row.id);
	}

	return resolved;
}
