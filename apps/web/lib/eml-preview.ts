// ss2i : apercu d'un mail joint (.eml, message/rfc822) dans la visionneuse (Hugo le 24/11/2026 :
// « on a des pieces jointes en .eml souvent, mais on peut pas les visualiser »). Le serveur
// decode le fichier avec mailparser, comme le worker a la reception (lib/eml-parse.ts), et
// la visionneuse l'affiche avec le lecteur des mails (EmailViewer : DOMPurify, images
// distantes bloquees). Ses propres pieces jointes se telechargent une a une.
// Ce fichier ne depend pas de mailparser : il est importe cote navigateur.

// Au-dela, decoder le mail charge trop le serveur : on propose le telechargement.
export const EML_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
// Images inline (cid:) renvoyees dans la reponse, en data: ; au-dela, laissees de cote.
export const EML_INLINE_MAX_BYTES = 10 * 1024 * 1024;

const EML_TYPES = ["message/rfc822", "message/global"];

export function canPreviewEml(a: { filenameOriginal?: string | null; contentType?: string | null }) {
	const type = (a.contentType || "").split(";")[0].trim().toLowerCase();
	return EML_TYPES.includes(type) || /\.eml$/i.test(a.filenameOriginal || "");
}

export type EmlAddress = { name?: string | null; address?: string | null };
export type EmlAddressField = { value: EmlAddress[] } | null;

export type EmlAttachment = {
	index: number;
	filename: string;
	contentType: string;
	size: number;
};

export type EmlPreviewData = {
	subject: string | null;
	date: string | null;
	from: EmlAddressField;
	to: EmlAddressField;
	cc: EmlAddressField;
	replyTo: EmlAddressField;
	html: string | null;
	text: string | null;
	// Content-ID (sans chevrons, en minuscules) -> data: de l'image, pour EmailViewer.cidUrls.
	cidUrls: Record<string, string>;
	attachments: EmlAttachment[];
};

// Index de la piece jointe interne demandee (?mode=part&part=N), ou null.
export function parsePartIndex(value: string | null): number | null {
	if (value === null || !/^\d{1,4}$/.test(value)) return null;
	return Number(value);
}

export function emlPartLink(attachmentId: string, index: number) {
	return `/api/attachments/${encodeURIComponent(attachmentId)}?mode=part&part=${index}`;
}

// Nom de fichier d'une piece interne sans nom (souvent un mail transfere ou une image).
export function emlPartName(filename: string | null | undefined, contentType: string, index: number) {
	const name = (filename || "").trim();
	if (name) return name;
	const type = contentType.toLowerCase();
	if (EML_TYPES.includes(type)) return `message-${index + 1}.eml`;
	const ext = type.split("/")[1]?.replace(/[^a-z0-9]/g, "").slice(0, 5);
	return `piece-jointe-${index + 1}${ext ? `.${ext}` : ""}`;
}
