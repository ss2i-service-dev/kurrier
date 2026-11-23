// Preview of text and CSV attachments. The iframe used to point at the S3 URL, and Chrome
// downloads a text/csv instead of displaying it (blank page). The bytes now go through
// /api/attachments/<id>?mode=content, are decoded in the browser and rendered by React
// (never interpreted): a table for a CSV, text otherwise.
// Pure functions, tested by apps/web/test/text-preview.ts.

// Beyond this, the download is offered: the browser would struggle to render the table.
export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

type FileInfo = { filenameOriginal?: string | null; contentType?: string | null; sizeBytes?: number | null };

const TEXT_EXTENSIONS = new Set([
	"csv", "tsv", "tab", "txt", "text", "log", "md", "markdown", "json", "xml", "yaml", "yml",
	"ini", "cfg", "conf", "toml", "sql", "sh", "ps1", "bat", "cmd", "nfo", "diff", "patch",
]);
// Rendered elsewhere (S3 iframe, calendar preview) or executable: never as text.
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
		// Excel exports and legacy business software: almost always Windows-1252.
		return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
	}
}

const CANDIDATES = [";", ",", "\t", "|"] as const;

// Number of delimiters outside quotes on each of the first lines.
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
		// A real delimiter comes back the same number of times on every line.
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

// Beyond this, rendering the table slows the browser down: the rest comes with the download.
export const MAX_TABLE_ROWS = 5000;
const NUMBER = /^[-+]?[\d\s  .,]*\d[\d\s  .,]*\s?(%|€|\$|£|EUR|CAD|USD)?$/i;

// Displayable table (CSV or workbook sheet): first row = headers, `rows` may be shorter than
// `totalRows` (at most MAX_TABLE_ROWS + 1 rows read), `totalRows` counts the header.
export function buildTable(rows: string[][], totalRows: number) {
	const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
	const [header = [], ...body] = rows;
	// A column is numeric if all its non-empty cells are: right-aligned.
	const numeric = Array.from({ length: columns }, (_, c) => {
		const values = body.map((r) => (r[c] ?? "").trim()).filter(Boolean);
		return values.length > 0 && values.every((v) => NUMBER.test(v));
	});
	// Long text column (labels): wrapped with a minimum width; the others (dates, codes,
	// amounts) stay on one line.
	const long = Array.from({ length: columns }, (_, c) => body.some((r) => (r[c] ?? "").length > 40));
	return { header, body: body.slice(0, MAX_TABLE_ROWS), totalRows: Math.max(0, totalRows - 1), columns, numeric, long };
}
export type PreviewTable = ReturnType<typeof buildTable>;
