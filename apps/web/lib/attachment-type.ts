// ss2i : type reel d'une piece jointe declaree avec un type generique ou faux (Hugo le 24/11/2026 :
// des pdf et des png recus en application/x-file-download, application/octetstream, « pdf »,
// text/x-moz-deleted... ne s'ouvraient pas dans la visionneuse). Le type declare reste la
// reference ; seul un type qui n'apprend rien cede la place a celui de l'extension.
// Fonctions pures, testees par apps/web/test/attachment-type.ts.
import mime from "mime-types";

const GENERIC_TYPES = new Set([
	"application/octet-stream",
	"application/octetstream",
	"application/x-file-download",
	"application/force-download",
	"application/x-download",
	"application/download",
	"application/binary",
	"application/unknown",
	"application/applefile",
	"binary/octet-stream",
	"text/x-moz-deleted",
]);

// Types que l'on accepte de faire servir par S3 a la place du type declare, pour l'ouverture
// dans la visionneuse : jamais de HTML, de SVG ni de script.
const SERVABLE = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|wav|x-wav|mp4|ogg))$/;

const extOf = (filename: string | null | undefined) => {
	const n = (filename || "").toLowerCase();
	return n.includes(".") ? n.split(".").pop() || "" : "";
};

// Type declare (sans parametres) s'il est parlant, sinon celui de l'extension, sinon "".
export function effectiveType(contentType: string | null | undefined, filename: string | null | undefined) {
	const declared = (contentType || "").split(";")[0].trim().toLowerCase();
	const ext = extOf(filename);
	const guessed = ext ? String(mime.lookup(ext) || "").toLowerCase() : "";
	// « pdf », « jpg » : pas un type MIME (pas de barre oblique), aussi peu parlant.
	const generic = !declared || GENERIC_TYPES.has(declared) || !declared.includes("/");
	return generic ? guessed || declared : declared;
}

// Type a imposer a S3 pour l'ouverture, quand le type stocke est generique ; sinon undefined.
export function servedTypeOverride(contentType: string | null | undefined, filename: string | null | undefined) {
	const declared = (contentType || "").split(";")[0].trim().toLowerCase();
	const type = effectiveType(contentType, filename);
	return type !== declared && SERVABLE.test(type) ? type : undefined;
}
