// Stable addresses of the attachments of a message. The S3 URLs used to be signed when the
// thread was displayed, for 5 minutes: past that delay, the click ended on the XML error of
// the storage ("Bad request: Date is too old"). The page now only carries
// /api/attachments/<id>, and the signature happens at click time. Pure functions, tested by
// apps/web/test/attachment-links.ts.

export type AttachmentLinkMode = "open" | "download";

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
	return value === "download" ? value : null;
}

export function attachmentUrls(a: { id: string }) {
	return {
		signedUrl: attachmentLink(a.id),
		downloadUrl: attachmentLink(a.id, "download"),
	};
}

// Content-Disposition attachment with an ASCII fallback name and a UTF-8 name (RFC 6266).
export function attachmentDisposition(filename: string | null | undefined) {
	const name = (filename || "attachment").replace(/[\r\n"\\]/g, "_");
	const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");
	const utf8 = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
