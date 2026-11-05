// Moving a recipient from one field (To, Cc, Bcc) to another: pure logic, without
// React or DOM, so it can be tested on its own (apps/worker/test/recipients-move.ts).
export const RECIPIENT_DRAG_TYPE = "application/x-kurrier-recipient";

export type RecipientField = "to" | "cc" | "bcc";

export const RECIPIENT_FIELDS: RecipientField[] = ["to", "cc", "bcc"];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Adds without duplicates (case-insensitive); returns the same list if nothing changes.
export function addRecipients(list: string[], emails: string[]): string[] {
	const out = [...list];
	for (const e of emails) {
		if (e.trim() && !out.some((x) => same(x, e))) out.push(e);
	}
	return out.length === list.length ? list : out;
}

// Removes the address from `from` and adds it to `to` (never a duplicate). Same field: nothing.
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
