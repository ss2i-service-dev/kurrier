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
 *
 * ss2i (12/11) : `absent`, si fourni, recoit les lignes dont l'absence du dossier est prouvee :
 * ni a leur UID, ni par SEARCH, ni dans la lecture COMPLETE des enveloppes du dossier (dossier
 * lisible, d'au plus SCAN_LIMIT messages, lecture sans erreur). Une ligne seulement « pas
 * trouvee » (dossier trop gros, lecture en erreur) n'y est pas.
 *
 * ss2i (16/11, INBOX Gmail de plus de 5 000 messages) : chez Gmail (X-GM-EXT-1), l'absence est
 * aussi prouvee quand l'UID en base ne porte pas le message (FETCH sans erreur), que SEARCH
 * HEADER Message-ID et X-GM-RAW « rfc822msgid: » repondent tous deux sans erreur et vides. Sans
 * cela, un message supprime de Gmail par un autre client revenait dans INBOX a chaque mise a la
 * corbeille, le dossier etant trop gros pour etre balaye.
 */
const SCAN_LIMIT = 5000;

export async function resolveUids(
	client: ImapFlow,
	rows: UidRow[],
	absent?: Set<string>,
): Promise<Map<number, string>> {
	const resolved = new Map<number, string>();

	// Enveloppes du dossier, lues une seule fois et seulement si SEARCH n'a rien rendu.
	// scanComplete : le dossier entier a ete lu (ou il est vide), l'absence y est prouvee.
	let scanned: Map<string, number[]> | undefined;
	let scanComplete = false;
	const scan = async () => {
		if (scanned) return scanned;
		scanned = new Map();
		const box = client.mailbox;
		if (!box || typeof box !== "object") return scanned;
		const exists = Number(box.exists ?? 0);
		if (exists > SCAN_LIMIT) return scanned;
		if (exists > 0) {
			for await (const m of client.fetch("1:*", { uid: true, envelope: true })) {
				const key = norm(m.envelope?.messageId);
				if (!key) continue;
				scanned.set(key, [...(scanned.get(key) ?? []), m.uid]);
			}
		}
		scanComplete = true;
		return scanned;
	};

	// Enveloppes des UID en base, en UN seul FETCH : une selection de 50 fils faisait
	// 50 allers-retours (plusieurs secondes chez Gmail) avant de deplacer quoi que ce soit.
	const atUid = new Map<number, string>();
	let atUidRead = false;
	const gmail = Boolean((client as any).capabilities?.has?.("X-GM-EXT-1"));
	const uidList = [...new Set(rows.map((r) => Number(r.uid)).filter((u) => u > 0))];
	if (uidList.length) {
		try {
			for await (const m of client.fetch(uidList.join(","), { uid: true, envelope: true }, { uid: true })) {
				atUid.set(Number(m.uid), norm(m.envelope?.messageId));
			}
			atUidRead = true;
		} catch {
			// verification message par message ci-dessous
		}
	}

	for (const row of rows) {
		const wanted = norm(row.messageId);
		// Sans Message-ID en base, rien a comparer : comportement d'origine.
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
		// Gmail : seconde recherche par son operateur natif, qui fait foi.
		let gmailEmpty = false;
		if (!uids.length && gmail && Array.isArray(found)) {
			const raw = await client
				.search({ gmraw: `rfc822msgid:${wanted}` } as any, { uid: true })
				.catch(() => false as const);
			if (Array.isArray(raw)) {
				uids = raw;
				gmailEmpty = raw.length === 0;
			}
		}
		if (!uids.length) {
			uids = (await scan().catch(() => undefined))?.get(wanted) ?? [];
		}
		if (!uids.length) {
			const gmailProof = gmailEmpty && (Number(row.uid) <= 0 || atUidRead);
			if (scanComplete || gmailProof) absent?.add(row.id);
			const why = scanComplete ? ", dossier lu en entier" : gmailProof ? ", absent selon Gmail" : "";
			console.warn(
				`[imap:resolve-uids] message ${row.id} introuvable dans le dossier (uid en base ${row.uid}${why}), ignore`,
			);
			continue;
		}
		for (const uid of uids) resolved.set(Number(uid), row.id);
	}

	return resolved;
}
