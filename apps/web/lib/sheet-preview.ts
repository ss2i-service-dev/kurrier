// ss2i : apercu des classeurs xls, xlsx et ods (Samuel le 18/11/2026 : « et tant qu'a faire le
// csv, faut aussi faire le xls »). Les octets passent par /api/attachments/<id>?mode=content,
// sont lus dans le navigateur par SheetJS (importe a la demande : ~900 Ko, hors du bundle de
// la messagerie) et rendus par React comme un CSV, jamais interpretes : formules, macros et
// liens ne sont pas lus, chaque cellule arrive en texte tel que Excel l'affiche.
// Testes par apps/web/test/sheet-preview.ts.
import { MAX_TABLE_ROWS } from "./text-preview";

// Un xlsx de quelques Mo se decompresse en dizaines de Mo : au-dela, on propose le telechargement.
export const SHEET_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

type FileInfo = { filenameOriginal?: string | null; contentType?: string | null; sizeBytes?: number | null };

// ss2i : xlsb (classeur binaire Excel, zip lui aussi) lu par SheetJS comme les autres.
const SHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "xlsb", "ods"]);

export function canPreviewSheet(a: FileInfo) {
	const n = (a.filenameOriginal || "").toLowerCase();
	const ext = n.includes(".") ? n.split(".").pop() || "" : "";
	return SHEET_EXTENSIONS.has(ext) && Number(a.sizeBytes ?? 0) <= SHEET_PREVIEW_MAX_BYTES;
}

export type SheetData = { name: string; rows: string[][]; totalRows: number };

// `rows` : au plus MAX_TABLE_ROWS + 1 lignes (en-tetes compris) ; `totalRows` : taille reelle.
export async function parseWorkbook(bytes: Uint8Array): Promise<{ sheets: SheetData[] }> {
	// Zip (xlsx, ods) ou conteneur OLE2 (xls) seulement : SheetJS lirait sinon n'importe quel
	// texte comme un CSV, un « .xls » qui est en fait du HTML comme un document HTML.
	const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
	const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
	if (!zip && !ole) throw new Error("format de classeur non reconnu");
	const XLSX = await import("xlsx");
	const book = XLSX.read(bytes, {
		type: "array",
		// Lecture arretee apres les lignes affichees : `!fullref` garde l'etendue reelle.
		sheetRows: MAX_TABLE_ROWS + 1,
		dense: true,
		cellFormula: false,
		cellHTML: false,
		cellStyles: false,
		bookVBA: false,
	});
	const hidden = new Map((book.Workbook?.Sheets ?? []).map((s) => [s.name, !!s.Hidden]));
	const sheets: SheetData[] = [];
	for (const name of book.SheetNames) {
		if (hidden.get(name)) continue;
		const sheet = book.Sheets[name];
		if (!sheet) continue;
		const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
		const full = XLSX.utils.decode_range(String(sheet["!fullref"] ?? sheet["!ref"] ?? "A1:A1"));
		const empty = rows.length === 0 || (rows.length === 1 && rows[0].every((c) => c === ""));
		sheets.push({
			name,
			rows: rows.map((r) => r.map((c) => String(c ?? ""))),
			totalRows: empty ? 0 : Math.max(rows.length, full.e.r + 1),
		});
	}
	if (sheets.length === 0) throw new Error("classeur vide ou illisible");
	return { sheets };
}
