// Preview of workbooks (xls, xlsx, ods) in the viewer, same table as the CSV.
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/sheet-preview.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { attachmentUrls } from "../lib/attachment-links";
import { canPreviewSheet, parseWorkbook, SHEET_PREVIEW_MAX_BYTES } from "../lib/sheet-preview";
import { buildTable, MAX_TABLE_ROWS } from "../lib/text-preview";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";
const web = join(__dirname, "..");
const source = (path: string) => readFileSync(join(web, path), "utf8");

let failures = 0;
const test = async (label: string, fn: () => void | Promise<void>) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const workbook = (bookType: XLSX.BookType, sheets: Record<string, unknown[][]>, hidden: string[] = []) => {
	const wb = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
	wb.Workbook = { Sheets: Object.keys(sheets).map((name) => ({ name, Hidden: hidden.includes(name) ? 1 : 0 })) };
	return new Uint8Array(XLSX.write(wb, { type: "array", bookType }));
};

const main = async () => {
	await test("workbooks recognized by extension, never the CSV nor the text", () => {
		for (const name of ["a.xls", "A.XLSX", "a.xlsm", "a.ods"]) {
			assert.equal(canPreviewSheet({ filenameOriginal: name, contentType: "application/octet-stream", sizeBytes: 10 }), true, name);
		}
		assert.equal(canPreviewSheet({ filenameOriginal: "a.csv", contentType: "application/vnd.ms-excel", sizeBytes: 10 }), false);
		assert.equal(canPreviewSheet({ filenameOriginal: "a.docx", sizeBytes: 10 }), false);
		assert.equal(canPreviewSheet({ filenameOriginal: "a.xlsx", sizeBytes: SHEET_PREVIEW_MAX_BYTES + 1 }), false);
	});

	await test("preview link carried by the page, bytes served by the content mode", () => {
		const urls = attachmentUrls({ id: ID, filenameOriginal: "sales.xlsx", sizeBytes: 100 });
		assert.equal(urls.sheetUrl, `/api/attachments/${ID}?mode=content`);
		assert.equal(urls.textUrl, undefined);
		assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.csv", sizeBytes: 100 }).sheetUrl, undefined);
		assert.match(source("app/api/attachments/[id]/route.ts"), /canPreviewSheet\(attachment\)/);
	});

	for (const bookType of ["xlsx", "xls", "ods"] as const) {
		await test(`reading ${bookType}: one sheet per tab, cells as text`, async () => {
			const bytes = workbook(bookType, {
				Sales: [["Label", "Quantity"], ["Room", 12], ["Breakfast", 3.5]],
				Notes: [["a"], ["b"]],
			});
			const { sheets } = await parseWorkbook(bytes);
			assert.deepEqual(sheets.map((s) => s.name), ["Sales", "Notes"]);
			assert.deepEqual(sheets[0].rows[0], ["Label", "Quantity"]);
			assert.equal(sheets[0].rows[1][0], "Room");
			assert.equal(sheets[0].rows[1][1], "12");
			assert.equal(sheets[0].totalRows, 3);
			assert.equal(sheets[1].rows.length, 2);
		});
	}

	await test("hidden sheets ignored, rows capped with the real total", async () => {
		const many = [["n"], ...Array.from({ length: MAX_TABLE_ROWS + 500 }, (_, i) => [i])];
		const { sheets } = await parseWorkbook(workbook("xlsx", { Visible: many, Hidden: [["x"]] }, ["Hidden"]));
		assert.deepEqual(sheets.map((s) => s.name), ["Visible"]);
		assert.ok(sheets[0].rows.length <= MAX_TABLE_ROWS + 1, `rows read: ${sheets[0].rows.length}`);
		assert.equal(sheets[0].totalRows, MAX_TABLE_ROWS + 501);
	});

	await test("unreadable file: an error, not an empty table", async () => {
		await assert.rejects(parseWorkbook(new TextEncoder().encode("this is not a workbook \u0000\u0001")));
	});

	await test("shared table: numeric columns on the right, long labels wrapped", () => {
		const t = buildTable([["Label", "Qty"], ["x".repeat(60), "12"], ["short", "1,234.50 EUR"]], 3);
		assert.deepEqual(t.header, ["Label", "Qty"]);
		assert.deepEqual(t.numeric, [false, true]);
		assert.deepEqual(t.long, [true, false]);
		assert.equal(t.totalRows, 2);
		assert.equal(t.columns, 2);
	});

	await test("components: shared table, sheets as tabs, no HTML produced by the library", () => {
		const sheet = source("components/k/sheet-preview.tsx");
		assert.match(sheet, /parseWorkbook/);
		assert.doesNotMatch(sheet, /dangerouslySetInnerHTML|sheet_to_html/);
		assert.match(sheet, /role="tablist"/);
		assert.match(source("components/k/text-preview.tsx"), /<DataTable/);
		assert.match(sheet, /<DataTable/);
	});

	if (failures > 0) {
		console.error(`${failures} test(s) failed`);
		process.exit(1);
	}
};
main();
