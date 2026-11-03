// ss2i : images inline d'un message, affichees dans le corps ou non.
//
// mailparser remplace a la reception les references cid: du HTML par des data: URI ;
// certains messages gardent pourtant des cid: (le lecteur les resout alors par l'URL
// signee de la piece jointe). Une image marquee inline mais que le HTML n'affiche pas
// (capture jointe depuis un telephone, corps sans <img>) doit rester dans la liste des
// pieces jointes, sinon elle disparait : en cas de doute, on la montre.

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

// Content-ID -> URL signee, pour resoudre les cid: restes dans le HTML.
export function cidUrlMap(
	attachments: (InlineCandidate & { signedUrl?: string | null })[],
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const a of attachments ?? []) {
		if (a.cid && a.signedUrl) map[normalizeCid(a.cid)] = a.signedUrl;
	}
	return map;
}

// Ids des images inline effectivement affichees dans le corps HTML.
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

	// 1. Referencee par son Content-ID : affichee (le lecteur resout le cid:).
	const rest: InlineCandidate[] = [];
	for (const a of candidates) {
		if (body.includes(`cid:${normalizeCid(a.cid!)}`)) shown.add(a.id);
		else rest.push(a);
	}

	// 2. Les autres ont ete integrees en data: URI par mailparser : on les reconnait a
	//    la taille decodee de chaque data: URI du corps, egale a celle de la piece jointe.
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
