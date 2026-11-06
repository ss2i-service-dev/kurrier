// ss2i : apercu d'une piece jointe pendant la redaction, telle que le destinataire la recevra
// (Samuel le 06/11/2026 : « pour etre sur d'avoir mis la bonne »). Fonctions pures, testees par
// apps/web/test/compose-attachment-preview.ts.
import mime from "mime-types";

export type ComposeAttachment = {
	path: string;
	filenameOriginal?: string | null;
	contentType?: string | null;
	sizeBytes?: number | null;
};

// Memes familles que la visionneuse des messages recus (components/k/attachments.tsx).
const VIEWER_KINDS = ["image/", "video/", "audio/", "text/"];

export function previewModeFor(a: { filenameOriginal?: string | null; contentType?: string | null }): "viewer" | "open" {
	const name = (a.filenameOriginal || "").toLowerCase();
	const ext = name.includes(".") ? name.split(".").pop() || "" : "";
	const type = ((a.contentType || "") || (ext ? String(mime.lookup(ext) || "") : "")).toLowerCase();
	if (type === "application/pdf") return "viewer";
	if (type.includes("calendar") || ext === "ics") return "open";
	return VIEWER_KINDS.some((p) => type.startsWith(p)) ? "viewer" : "open";
}

export function toPreviewFile(a: ComposeAttachment, urls: { url: string; downloadUrl: string }) {
	return {
		id: a.path,
		path: a.path,
		filenameOriginal: a.filenameOriginal || "pièce jointe",
		contentType: a.contentType || null,
		sizeBytes: a.sizeBytes ?? null,
		signedUrl: urls.url,
		downloadUrl: urls.downloadUrl,
	};
}

// Content-Disposition attachment avec nom ASCII de repli et nom UTF-8 (RFC 6266), comme
// lib/actions/mailbox.ts pour les pieces recues.
export function attachmentDisposition(filename: string | null | undefined) {
	const name = (filename || "piece-jointe").replace(/[\r\n"\\]/g, "_");
	const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");
	const utf8 = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
