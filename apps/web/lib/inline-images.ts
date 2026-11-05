// Inline images of a message, shown in the body or not.
//
// mailparser replaces cid: references in the HTML with data: URIs on reception; some
// messages still keep cid: references (the reader then resolves them through the signed URL
// of the attachment). An image marked inline but not shown by the HTML (screenshot attached
// from a phone, body without <img>) must stay in the attachment list, otherwise it
// disappears: when in doubt, show it.

type InlineCandidate = {
	id: string;
	cid?: string | null;
	isInline?: boolean | null;
	contentType?: string | null;
	filenameOriginal?: string | null;
	sizeBytes?: number | null;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i;

function isImage(a: InlineCandidate) {
	const ct = (a.contentType || "").toLowerCase();
	return ct.startsWith("image/") || IMAGE_EXT.test(a.filenameOriginal || "");
}

export function normalizeCid(cid: string) {
	return cid.replace(/^<|>$/g, "").trim().toLowerCase();
}

// Content-ID -> signed URL, to resolve the cid: references left in the HTML.
export function cidUrlMap(
	attachments: (InlineCandidate & { signedUrl?: string | null })[],
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const a of attachments ?? []) {
		if (a.cid && a.signedUrl) map[normalizeCid(a.cid)] = a.signedUrl;
	}
	return map;
}

// Ids of the inline images actually shown in the HTML body.
export function inlineImageIdsShownInBody(
	html: string | null | undefined,
	attachments: InlineCandidate[],
): Set<string> {
	const shown = new Set<string>();
	const body = (html || "").toLowerCase();
	if (!body.trim()) return shown;

	const candidates = (attachments ?? []).filter(
		(a) => a.isInline && a.cid && isImage(a),
	);

	// 1. Referenced by its Content-ID: shown (the reader resolves the cid:).
	const rest: InlineCandidate[] = [];
	for (const a of candidates) {
		if (body.includes(`cid:${normalizeCid(a.cid!)}`)) shown.add(a.id);
		else rest.push(a);
	}

	// 2. The others were embedded as data: URIs by mailparser: they are recognised by the
	//    decoded size of a data: URI of the body, equal to that of the attachment.
	if (rest.length > 0) {
		const sizes = new Set<number>();
		const re = /data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)/g;
		for (const m of body.matchAll(re)) {
			const b64 = m[1].replace(/\s+/g, "");
			const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
			sizes.add(Math.floor((b64.length * 3) / 4) - pad);
		}
		for (const a of rest) if (a.sizeBytes && sizes.has(Number(a.sizeBytes))) shown.add(a.id);
	}

	return shown;
}
