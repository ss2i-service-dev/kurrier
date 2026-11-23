// Attachments of a whole thread, brought up to the top of the conversation (the file used
// to sit at the very bottom, under the quoted history). Pure function, tested by
// apps/web/test/thread-attachments.ts.
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

// messages: oldest to newest. Result: newest to oldest, without drafts, without the images
// already visible in the body, and a file sent back several times (same content, or failing
// that same name and same size) appears once, in its most recent version.
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
