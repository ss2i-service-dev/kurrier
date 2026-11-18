// ss2i : adresses stables des pieces jointes d'un message (Hugo le 18/11/2026 : un pptx de
// Benoit s'ouvrait sur « Bad request: Date is too old »). Les URL S3 etaient signees a
// l'affichage du fil, pour 5 minutes : passe ce delai, le clic tombait sur l'erreur XML de
// Garage. La page ne porte plus que /api/attachments/<id>, et la signature se fait au clic.
// Fonctions pures, testees par apps/web/test/attachment-links.ts.
import { canPreviewSheet } from "./sheet-preview";
import { canPreviewText } from "./text-preview";
import { canListZip } from "./zip-listing";

export type AttachmentLinkMode = "open" | "download" | "content" | "listing";

// Au-dela, l'apercu d'un pptx charge trop le navigateur : on propose le telechargement.
export const PPTX_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAttachmentId(id: string) {
	return UUID.test(id);
}

export function attachmentLink(id: string, mode: AttachmentLinkMode = "open") {
	const path = `/api/attachments/${encodeURIComponent(id)}`;
	return mode === "open" ? path : `${path}?mode=${mode}`;
}

export function parseAttachmentMode(value: string | null): AttachmentLinkMode | null {
	if (value === null || value === "open") return "open";
	return value === "download" || value === "content" || value === "listing" ? value : null;
}

export function canPreviewPptx(a: {
	filenameOriginal?: string | null;
	contentType?: string | null;
	sizeBytes?: number | null;
}) {
	const type = (a.contentType || "").split(";")[0].trim().toLowerCase();
	const isPptx = type === PPTX_MIME || /\.pptx$/i.test(a.filenameOriginal || "");
	return isPptx && Number(a.sizeBytes ?? 0) <= PPTX_PREVIEW_MAX_BYTES;
}

export function attachmentUrls(a: {
	id: string;
	filenameOriginal?: string | null;
	contentType?: string | null;
	sizeBytes?: number | null;
}) {
	return {
		signedUrl: attachmentLink(a.id),
		downloadUrl: attachmentLink(a.id, "download"),
		contentUrl: canPreviewPptx(a) ? attachmentLink(a.id, "content") : undefined,
		// Texte et CSV : memes octets, rendus en texte ou en tableau (lib/text-preview.ts).
		textUrl: canPreviewText(a) ? attachmentLink(a.id, "content") : undefined,
		// Classeurs xls, xlsx, ods : memes octets, lus par SheetJS dans le navigateur (lib/sheet-preview.ts).
		sheetUrl: canPreviewSheet(a) ? attachmentLink(a.id, "content") : undefined,
		// Zip : liste des fichiers seulement (lib/zip-listing.ts), rien n'est decompresse.
		zipUrl: canListZip(a) ? attachmentLink(a.id, "listing") : undefined,
	};
}
