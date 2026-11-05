// ss2i : coller (ou deposer) une image du presse-papiers directement dans le corps du
// mail (Samuel le 05/11 : « c'est dans le buffer de copier-coller, on colle, ça pose
// inline »). L'image entre dans l'editeur en data: URI ; a l'envoi SMTP, attachDataUrls
// (packages/providers/src/mail/smtp.ts) la transforme en piece jointe integree (cid).

const MAX_SIDE = 1920; // une capture d'ecran plein ecran reste lisible
const KEEP_AS_IS_BYTES = 400 * 1024;
const PNG_MAX_BYTES = 1024 * 1024;

// Images du presse-papiers ou du glisser-deposer. Un collage qui porte du texte (Word,
// Excel, page web) garde le comportement normal : l'image n'y est qu'un rendu de la
// selection, c'est le texte qu'on veut.
export function pastedImageFiles(dt: DataTransfer | null, opts: { ignoreIfText: boolean }): File[] {
	if (!dt) return [];
	if (opts.ignoreIfText && (dt.getData("text/plain") || "").trim()) return [];
	const files: File[] = [];
	for (const item of Array.from(dt.items || [])) {
		if (item.kind === "file" && item.type.startsWith("image/")) {
			const f = item.getAsFile();
			if (f) files.push(f);
		}
	}
	if (!files.length) {
		for (const f of Array.from(dt.files || [])) if (f.type.startsWith("image/")) files.push(f);
	}
	return files;
}

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result));
		r.onerror = () => reject(r.error);
		r.readAsDataURL(blob);
	});
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new window.Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image illisible"));
		img.src = src;
	});
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// data: URI de l'image, reduite si elle est tres grande : le corps du mail passe par une
// action serveur et part tel quel chez le destinataire.
export async function imageFileToDataUrl(file: File): Promise<string> {
	const original = await readAsDataUrl(file);
	if (file.type === "image/gif" || file.type === "image/svg+xml") return original;
	const img = await loadImage(original);
	const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
	if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) return original;
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
	canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) return original;
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	// PNG garde le texte d'une capture net ; trop lourd, JPEG sur fond blanc.
	const png = await canvasBlob(canvas, "image/png");
	if (png && png.size <= PNG_MAX_BYTES) return readAsDataUrl(png);
	const flat = document.createElement("canvas");
	flat.width = canvas.width;
	flat.height = canvas.height;
	const fctx = flat.getContext("2d");
	if (!fctx) return original;
	fctx.fillStyle = "#fff";
	fctx.fillRect(0, 0, flat.width, flat.height);
	fctx.drawImage(canvas, 0, 0);
	const jpeg = await canvasBlob(flat, "image/jpeg", 0.85);
	if (!jpeg) return original;
	return jpeg.size < file.size ? readAsDataUrl(jpeg) : original;
}
