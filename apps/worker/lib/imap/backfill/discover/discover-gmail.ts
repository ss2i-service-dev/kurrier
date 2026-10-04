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
		// ss2i : « Tous les messages » (\All) n'est plus ecarte. C'est le seul dossier qui porte
		// le courrier archive, soit l'essentiel d'une boite Gmail. Il est enregistre comme dossier
		// d'archive, rattrape en dernier et dedoublonne par Message-ID (cf. backfill-full.ts).
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
