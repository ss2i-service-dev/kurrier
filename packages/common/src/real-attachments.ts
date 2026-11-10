// ss2i : piece jointe reelle ou image integree au corps (Samuel le 10/11). Une image referencee
// par cid ou en disposition inline (signature, logo) n'est pas une piece jointe ; tout autre
// fichier en est une, meme avec un Content-ID (Apple Mail, Outlook en donnent aux PDF).
// Meme regle en SQL (REAL_ATTACHMENT_SQL, alias a de message_attachments) pour la liste et la
// migration ss2i_007.
export type AttachmentLike = {
	contentType?: string | null;
	cid?: string | null;
	contentDisposition?: string | null;
	isInline?: boolean | null;
};

export function isRealAttachment(a: AttachmentLike | null | undefined): boolean {
	if (!a) return false;
	const isImage = String(a.contentType ?? "").toLowerCase().startsWith("image/");
	if (!isImage) return true;
	const inline = !!a.cid || !!a.isInline || String(a.contentDisposition ?? "").toLowerCase() === "inline";
	return !inline;
}

export function hasRealAttachments(list: readonly (AttachmentLike | null | undefined)[] | null | undefined): boolean {
	return (list ?? []).some(isRealAttachment);
}

export const REAL_ATTACHMENT_SQL = "not (coalesce(a.content_type, '') ilike 'image/%' and (a.is_inline or a.cid is not null))";
