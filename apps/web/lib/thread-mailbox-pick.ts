// ss2i : fonction pure (testee par test/thread-mailbox.ts, sans base ni alias).
// Dossier du message le plus recent du fil qui appartient a l'identite.
export function pickThreadMailboxSlug(
	mailboxList: { id?: unknown; slug?: string | null }[],
	messages: { mailboxId: string | null }[],
): string | null {
	const byId = new Map(mailboxList.map((m) => [String(m.id), m]));
	const own = [...messages]
		.reverse()
		.map((m) => byId.get(String(m.mailboxId)))
		.find(Boolean);
	return own?.slug ?? null;
}
