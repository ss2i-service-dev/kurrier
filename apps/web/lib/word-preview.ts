// ss2i : apercu des documents Word (.docx) dans la visionneuse (Hugo le 24/11/2026 : 874 docx
// recus, aucun apercu). Les octets passent par /api/attachments/<id>?mode=content (meme origine,
// S3 refuse le fetch du navigateur) et sont rendus dans le navigateur par docx-preview : le
// fichier ne part chez aucun service tiers. .doc et .odt (formats binaire et OpenDocument)
// demanderaient une conversion serveur (LibreOffice) : non couverts.
// Fonctions pures, testees par apps/web/test/word-preview.ts.

// Un docx de quelques Mo se decompresse bien plus gros : au-dela, on propose le telechargement.
export const WORD_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const DOCX_TYPES = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-word.document.macroenabled.12",
]);

export function canPreviewWord(a: { filenameOriginal?: string | null; contentType?: string | null; sizeBytes?: number | null }) {
	const type = (a.contentType || "").split(";")[0].trim().toLowerCase();
	const isDocx = DOCX_TYPES.has(type) || /\.(docx|docm)$/i.test(a.filenameOriginal || "");
	return isDocx && Number(a.sizeBytes ?? 0) <= WORD_PREVIEW_MAX_BYTES;
}

// Adresses gardees dans le rendu : liens web et mail, ancres internes, images du document
// (blob: ou data:image produits par docx-preview). Tout le reste (javascript:, file:, ...) saute.
export function safeDocUrl(url: string, kind: "href" | "src") {
	const u = url.trim();
	if (kind === "href") return /^(https?:|mailto:|tel:|#)/i.test(u) ? u : null;
	return /^(blob:|data:image\/)/i.test(u) ? u : null;
}
