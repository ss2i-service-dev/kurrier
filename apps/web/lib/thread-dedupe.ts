// ss2i : fonction pure (testee par test/thread-dedupe.ts, sans base ni alias).
// Un meme mail peut exister plusieurs fois dans un fil, une ligne par dossier : la copie
// du dossier Sent et la copie recue dans l'Inbox quand une adresse en copie arrive dans la
// meme boite (dev@ chez samuel@). Le fil n'en affiche qu'une, par Message-ID.
// Les messages arrivent du plus ancien au plus recent ; on garde la derniere copie, a sa
// place : c'est elle que pickThreadMailboxSlug retient pour le dossier du fil.
// Un Message-ID vide n'est jamais fusionne.
const key = (id: unknown) =>
	String(id ?? "")
		.trim()
		.replace(/^<|>$/g, "")
		.toLowerCase();

export function dedupeThreadMessages<T extends { messageId?: string | null }>(messages: T[]): T[] {
	const last = new Map<string, number>();
	messages.forEach((m, i) => {
		const k = key(m.messageId);
		if (k) last.set(k, i);
	});
	return messages.filter((m, i) => {
		const k = key(m.messageId);
		return !k || last.get(k) === i;
	});
}
