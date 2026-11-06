// Message recu que le proprietaire a lui-meme ecrit : envoye de samuel@ avec dev@ en copie,
// il revient dans l'Inbox de samuel@ sans drapeau \Seen. Il entre lu (messages.seen, donc
// aussi mailbox_threads.unread_count), l'auteur l'ayant forcement lu.
// Fonction pure (apps/worker/test/own-message.ts) : `identities` sont les adresses d'identite
// du proprietaire ; une valeur sans « @ » (identite de domaine) n'en fait pas partie, sinon
// tout expediteur du domaine passerait pour le proprietaire.

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function isOwnMessage(
	from: string | null | undefined,
	identities: Iterable<string>,
): boolean {
	const addr = norm(from);
	if (!addr.includes("@")) return false;
	for (const identity of identities) {
		const value = norm(identity);
		if (value.includes("@") && value === addr) return true;
	}
	return false;
}
