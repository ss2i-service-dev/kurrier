// Deplacement d'un destinataire d'un champ (To, Cc, Bcc) a un autre : logique pure, sans
// React ni DOM, pour etre testee seule (apps/worker/test/recipients-move.ts).
export const RECIPIENT_DRAG_TYPE = "application/x-kurrier-recipient";

export type RecipientField = "to" | "cc" | "bcc";

export const RECIPIENT_FIELDS: RecipientField[] = ["to", "cc", "bcc"];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Ajoute sans doublon (casse ignoree) ; renvoie la meme liste si rien ne change.
export function addRecipients(list: string[], emails: string[]): string[] {
	const out = [...list];
	for (const e of emails) {
		if (e.trim() && !out.some((x) => same(x, e))) out.push(e);
	}
	return out.length === list.length ? list : out;
}

// Retire l'adresse de `from` et l'ajoute a `to` (jamais de doublon). Meme champ : rien.
export function moveRecipient(
	lists: Record<RecipientField, string[]>,
	email: string,
	from: RecipientField,
	to: RecipientField,
): Record<RecipientField, string[]> {
	if (from === to) return lists;
	return {
		...lists,
		[from]: lists[from].filter((x) => !same(x, email)),
		[to]: addRecipients(lists[to], [email]),
	};
}
