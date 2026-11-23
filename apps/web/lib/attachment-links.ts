// Stable addresses of the attachments of a message. The S3 URLs used to be signed when the
// thread was displayed, for 5 minutes: past that delay, the click ended on the XML error of
// the storage ("Bad request: Date is too old"). The page now only carries
// /api/attachments/<id>, and the signature happens at click time. Pure functions, tested by
// apps/web/test/attachment-links.ts.

export type AttachmentLinkMode = "open" | "download" | "content";

// Beyond this, the preview of a .pptx loads the browser too much: the download is offered.
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
	return value === "download" || value === "content" ? value : null;
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
	};
}

// Content-Disposition attachment with an ASCII fallback name and a UTF-8 name (RFC 6266).
export function attachmentDisposition(filename: string | null | undefined) {
	const name = (filename || "attachment").replace(/[\r\n"\\]/g, "_");
	const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");
	const utf8 = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
