// ss2i : pieces jointes de tout un fil, remontees en haut de la conversation (Hugo le
// 18/11/2026 : la piece jointe etait tout en bas, sous l'historique cite). Fonction pure,
// testee par apps/web/test/thread-attachments.ts.
import { inlineImageIdsShownInBody } from "./inline-images";

type ThreadMessage = { id: string; html?: string | null; draft?: boolean | null };

type ThreadAttachment = {
	id: string;
	messageId: string;
	cid?: string | null;
	isInline?: boolean | null;
	contentType?: string | null;
	filenameOriginal?: string | null;
	sizeBytes?: number | null;
	checksum?: string | null;
};

// messages : du plus ancien au plus recent. Resultat : du plus recent au plus ancien, sans les
// brouillons, sans les images deja visibles dans le corps, et un fichier renvoye plusieurs fois
// (meme contenu, ou a defaut meme nom et meme taille) n'apparait qu'une fois, dans sa version
// la plus recente.
export function selectThreadAttachments<T extends ThreadAttachment>(messages: ThreadMessage[], attachments: T[]): T[] {
	const seen = new Set<string>();
	const selected: T[] = [];
	for (const message of [...messages].reverse()) {
		if (message.draft) continue;
		const own = attachments.filter((a) => a.messageId === message.id);
		const shownInBody = inlineImageIdsShownInBody(message.html, own);
		for (const attachment of own) {
			if (shownInBody.has(attachment.id)) continue;
			const name = (attachment.filenameOriginal || "").toLowerCase();
			const key = attachment.checksum || `${name}|${attachment.sizeBytes ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			selected.push(attachment);
		}
	}
	return selected;
}
