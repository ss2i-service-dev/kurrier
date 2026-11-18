// ss2i : apercu des pieces jointes texte et CSV (Samuel le 18/11/2026 : un CSV recu s'ouvrait
// sur une page blanche, l'iframe pointait l'URL S3 et Chrome telecharge un text/csv au lieu
// de l'afficher). Les octets passent par /api/attachments/<id>?mode=content, sont decodes
// dans le navigateur et rendus par React (jamais interpretes) : tableau pour un CSV, texte sinon.
// Fonctions pures, testees par apps/web/test/text-preview.ts.

// Au-dela, on propose le telechargement : le navigateur peinerait a rendre le tableau.
export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

type FileInfo = { filenameOriginal?: string | null; contentType?: string | null; sizeBytes?: number | null };

const TEXT_EXTENSIONS = new Set([
	"csv", "tsv", "tab", "txt", "text", "log", "md", "markdown", "json", "xml", "yaml", "yml",
	"ini", "cfg", "conf", "toml", "sql", "sh", "ps1", "bat", "cmd", "nfo", "diff", "patch",
]);
// Rendus ailleurs (iframe S3, apercu agenda) ou executables : jamais en texte.
const EXCLUDED_EXTENSIONS = new Set(["html", "htm", "svg", "ics"]);
const EXCLUDED_TYPES = new Set(["text/html", "text/calendar"]);
const TEXT_APP_TYPES = new Set(["application/json", "application/xml", "application/x-yaml", "application/sql"]);

function extOf(name?: string | null) {
	const n = (name || "").toLowerCase();
	return n.includes(".") ? n.split(".").pop() || "" : "";
}
function typeOf(type?: string | null) {
	return (type || "").split(";")[0].trim().toLowerCase();
}

export function canPreviewText(a: FileInfo) {
	const ext = extOf(a.filenameOriginal);
	const type = typeOf(a.contentType);
	if (EXCLUDED_EXTENSIONS.has(ext) || EXCLUDED_TYPES.has(type)) return false;
	const isText = TEXT_EXTENSIONS.has(ext) || (!ext && (type.startsWith("text/") || TEXT_APP_TYPES.has(type)));
	return isText && Number(a.sizeBytes ?? 0) <= TEXT_PREVIEW_MAX_BYTES;
}

export function isTabular(a: Omit<FileInfo, "sizeBytes">) {
	const ext = extOf(a.filenameOriginal);
	const type = typeOf(a.contentType);
	return ext === "csv" || ext === "tsv" || ext === "tab" || type === "text/csv" || type === "text/tab-separated-values";
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "UTF-16LE" };
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "UTF-16BE" };
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
	} catch {
		// Export Excel ou logiciel de gestion francais : presque toujours Windows-1252.
		return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
	}
}

const CANDIDATES = [";", ",", "\t", "|"] as const;

// Nombre de separateurs hors guillemets sur chaque ligne des premieres lignes.
function countsPerLine(text: string, delim: string, maxLines = 20) {
	const counts: number[] = [];
	let n = 0;
	let quoted = false;
	for (let i = 0; i < text.length && counts.length < maxLines; i++) {
		const c = text[i];
		if (c === '"') quoted = !quoted;
		else if (!quoted && c === delim) n++;
		else if (!quoted && c === "\n") {
			counts.push(n);
			n = 0;
		}
	}
	if (counts.length < maxLines && n > 0) counts.push(n);
	return counts;
}

export function detectDelimiter(text: string): string {
	let best: string = ",";
	let bestScore = 0;
	for (const d of CANDIDATES) {
		const counts = countsPerLine(text, d);
		if (counts.length === 0 || counts[0] === 0) continue;
		// Un vrai separateur revient le meme nombre de fois sur chaque ligne.
		const same = counts.filter((c) => c === counts[0]).length / counts.length;
		const score = same * counts[0] + (same === 1 ? 1000 : 0);
		if (score > bestScore) {
			bestScore = score;
			best = d;
		}
	}
	return best;
}

export function parseCsv(text: string, delim: string, maxRows = Number.POSITIVE_INFINITY) {
	const rows: string[][] = [];
	let totalRows = 0;
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;
	const endRow = () => {
		row.push(field);
		field = "";
		totalRows++;
		if (rows.length < maxRows) rows.push(row);
		row = [];
	};
	while (i < text.length) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
		} else if (c === '"' && field === "") quoted = true;
		else if (c === delim) {
			row.push(field);
			field = "";
		} else if (c === "\r" && text[i + 1] === "\n") {
			endRow();
			i++;
		} else if (c === "\n" || c === "\r") endRow();
		else field += c;
		i++;
	}
	if (field !== "" || row.length > 0) endRow();
	return { rows, totalRows, truncated: totalRows > rows.length };
}

// Au-dela, le rendu du tableau ralentit le navigateur : le reste s'obtient en telechargeant.
export const MAX_TABLE_ROWS = 5000;
const NUMBER = /^[-+]?[\d\s  .,]*\d[\d\s  .,]*\s?(%|€|\$|£|EUR|CAD|USD)?$/i;

// Tableau affichable (CSV ou feuille de classeur) : premiere ligne = en-tetes, `rows` peut etre
// plus court que `totalRows` (lignes lues au plus MAX_TABLE_ROWS + 1), `totalRows` compte l'en-tete.
export function buildTable(rows: string[][], totalRows: number) {
	const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
	const [header = [], ...body] = rows;
	// Une colonne est numerique si toutes ses cellules non vides le sont : alignee a droite.
	const numeric = Array.from({ length: columns }, (_, c) => {
		const values = body.map((r) => (r[c] ?? "").trim()).filter(Boolean);
		return values.length > 0 && values.every((v) => NUMBER.test(v));
	});
	// Colonne de texte long (libelles) : retour a la ligne et largeur mini ; les autres
	// (dates, codes, montants) restent sur une ligne.
	const long = Array.from({ length: columns }, (_, c) => body.some((r) => (r[c] ?? "").length > 40));
	return { header, body: body.slice(0, MAX_TABLE_ROWS), totalRows: Math.max(0, totalRows - 1), columns, numeric, long };
}
export type PreviewTable = ReturnType<typeof buildTable>;
