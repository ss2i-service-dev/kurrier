import { ImapFlow } from "imapflow";

export type ImapBox = Awaited<ReturnType<ImapFlow["list"]>>[number];

export function isGmailAccountFromBoxes(boxes: ImapBox[]): boolean {
	return boxes.some(
		(b) =>
			b.path.startsWith("[Gmail]") ||
			(typeof b.specialUse === "string" &&
				b.specialUse.toLowerCase() === "\\all"),
	);
}

export function shouldSyncBox(box: ImapBox, isGmail: boolean): boolean {
	if (!box.listed) return false;
	if (box.flags?.has("\\Noselect")) return false;

	const path = box.path.toLowerCase();
	if (isGmail) {
		// "All Mail" (\All) is not skipped: it is the only folder that holds archived mail,
		// which is most of a Gmail mailbox. It is registered as the archive folder, backfilled
		// last and deduplicated by Message-ID (see backfill-full.ts).
		if (path === "[gmail]") return false;
		if (path === "[gmail]/important") return false;
		if (path === "[gmail]/notes") return false;
		if (path === "notes") return false;
	}

	return true;
}

export function isAllMailBox(specialUse?: string | null): boolean {
	return (specialUse ?? "").toLowerCase() === "\\all";
}
