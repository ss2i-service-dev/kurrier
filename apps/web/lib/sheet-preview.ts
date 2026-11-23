// Preview of xls, xlsx and ods workbooks. The bytes go through
// /api/attachments/<id>?mode=content, are read in the browser by SheetJS (imported on demand:
// ~900 KB, kept out of the mail bundle) and rendered by React like a CSV, never interpreted:
// formulas, macros and links are not read, every cell arrives as the text Excel displays.
// Tested by apps/web/test/sheet-preview.ts.
import { MAX_TABLE_ROWS } from "./text-preview";

// An xlsx of a few MB unpacks to tens of MB: beyond this, the download is offered.
export const SHEET_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

type FileInfo = { filenameOriginal?: string | null; contentType?: string | null; sizeBytes?: number | null };

const SHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "ods"]);

export function canPreviewSheet(a: FileInfo) {
	const n = (a.filenameOriginal || "").toLowerCase();
	const ext = n.includes(".") ? n.split(".").pop() || "" : "";
	return SHEET_EXTENSIONS.has(ext) && Number(a.sizeBytes ?? 0) <= SHEET_PREVIEW_MAX_BYTES;
}

export type SheetData = { name: string; rows: string[][]; totalRows: number };

// `rows`: at most MAX_TABLE_ROWS + 1 rows (header included); `totalRows`: real size.
export async function parseWorkbook(bytes: Uint8Array): Promise<{ sheets: SheetData[] }> {
	// Zip (xlsx, ods) or OLE2 container (xls) only: SheetJS would otherwise read any text as a
	// CSV, and an ".xls" that is really HTML as an HTML document.
	const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
	const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
	if (!zip && !ole) throw new Error("unrecognized workbook format");
	const XLSX = await import("xlsx");
	const book = XLSX.read(bytes, {
		type: "array",
		// Reading stops after the displayed rows: `!fullref` keeps the real extent.
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
	if (sheets.length === 0) throw new Error("empty or unreadable workbook");
	return { sheets };
}
