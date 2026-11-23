// "Not spam" button of the open message. Returns the Inbox of the identity that owns the
// current folder, only if that folder is the Spam folder.
type IdentityBoxes = { identity?: unknown; mailboxes?: ({ id?: unknown; kind?: unknown } | null)[] | null };

export function inboxIdForSpam(identityMailboxes: readonly IdentityBoxes[] | null | undefined, activeMailboxId: string): string | null {
	for (const im of identityMailboxes ?? []) {
		const boxes = im?.mailboxes ?? [];
		const current = boxes.find((m) => m && String(m.id) === String(activeMailboxId));
		if (!current) continue;
		if (current.kind !== "spam") return null;
		const inbox = boxes.find((m) => m?.kind === "inbox");
		return inbox ? String(inbox.id) : null;
	}
	return null;
}
