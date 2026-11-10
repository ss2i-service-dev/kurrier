// Received message that the owner wrote: sent from owner@ with an alias in copy, it comes back
// into the Inbox of owner@ without the \Seen flag. It is stored as read (messages.seen, hence
// mailbox_threads.unread_count too), its author having necessarily read it.
// Pure function (apps/worker/test/own-message.ts): `identities` are the identity addresses of
// the owner; a value without "@" (domain identity) is not one of them, otherwise any sender of
// the domain would pass for the owner.

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
