// Real attachment or image embedded in the body. An image referenced by cid or with an inline
// disposition (signature, logo) is not an attachment; any other file is one, even with a
// Content-ID (Apple Mail and Outlook give one to PDFs).
// Same rule in SQL (REAL_ATTACHMENT_SQL, alias a of message_attachments) for the thread list
// and the community_005 migration.
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
