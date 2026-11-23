// Preview of text and CSV attachments in the viewer. A CSV used to open on a blank page (the
// iframe pointed at the S3 URL, and Chrome downloads a text/csv instead of displaying it).
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/text-preview.ts
import assert from "node:assert/strict";
import { attachmentUrls } from "../lib/attachment-links";
import {
	canPreviewText,
	decodeText,
	detectDelimiter,
	isTabular,
	parseCsv,
	TEXT_PREVIEW_MAX_BYTES,
} from "../lib/text-preview";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

// By extension (mail clients often send a CSV as application/vnd.ms-excel or
// application/octet-stream) or by text/* type. HTML and SVG stay out of it.
test("files that get a text preview", () => {
	assert.equal(canPreviewText({ filenameOriginal: "report.csv", contentType: "text/csv", sizeBytes: 3000 }), true);
	assert.equal(canPreviewText({ filenameOriginal: "export.CSV", contentType: "application/vnd.ms-excel", sizeBytes: 10 }), true);
	assert.equal(canPreviewText({ filenameOriginal: "export.csv", contentType: "application/octet-stream", sizeBytes: 10 }), true);
	assert.equal(canPreviewText({ filenameOriginal: "notes.txt", contentType: "text/plain", sizeBytes: 10 }), true);
	assert.equal(canPreviewText({ filenameOriginal: "data.json", contentType: "application/json", sizeBytes: 10 }), true);
	assert.equal(canPreviewText({ filenameOriginal: "no-extension", contentType: "text/plain", sizeBytes: 10 }), true);
});

test("HTML, SVG, PDF, calendar and oversized files are left out", () => {
	assert.equal(canPreviewText({ filenameOriginal: "page.html", contentType: "text/html", sizeBytes: 10 }), false);
	assert.equal(canPreviewText({ filenameOriginal: "logo.svg", contentType: "image/svg+xml", sizeBytes: 10 }), false);
	assert.equal(canPreviewText({ filenameOriginal: "report.pdf", contentType: "application/pdf", sizeBytes: 10 }), false);
	assert.equal(canPreviewText({ filenameOriginal: "invite.ics", contentType: "text/calendar", sizeBytes: 10 }), false);
	assert.equal(canPreviewText({ filenameOriginal: "big.csv", contentType: "text/csv", sizeBytes: TEXT_PREVIEW_MAX_BYTES + 1 }), false);
});

test("tabular files", () => {
	assert.equal(isTabular({ filenameOriginal: "a.csv", contentType: "application/octet-stream" }), true);
	assert.equal(isTabular({ filenameOriginal: "a.tsv", contentType: null }), true);
	assert.equal(isTabular({ filenameOriginal: "a", contentType: "text/csv; charset=utf-8" }), true);
	assert.equal(isTabular({ filenameOriginal: "a.txt", contentType: "text/plain" }), false);
});

test("the page carries the bytes URL for a text file, not for a PDF", () => {
	assert.equal(
		attachmentUrls({ id: ID, filenameOriginal: "a.csv", contentType: "text/csv", sizeBytes: 10 }).textUrl,
		`/api/attachments/${ID}?mode=content`,
	);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }).textUrl, undefined);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.csv", contentType: "text/csv", sizeBytes: 10 }).contentUrl, undefined);
});

// Encoding: UTF-8 (BOM removed), otherwise Windows-1252 (Excel export), UTF-16 with BOM.
test("encoding detection", () => {
	const enc = new TextEncoder();
	assert.deepEqual(decodeText(enc.encode("Label;Café")), { text: "Label;Café", encoding: "UTF-8" });
	assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("é")])).text, "é");
	assert.deepEqual(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80])), {
		text: "Café €",
		encoding: "Windows-1252",
	});
	assert.deepEqual(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00])), { text: "Aé", encoding: "UTF-16LE" });
});

// Delimiter: semicolon (Excel in many locales), comma, tab; ignored inside quotes.
test("delimiter detection", () => {
	assert.equal(detectDelimiter("Name;Amount\nSmith;12,50\nJones;3,00"), ";");
	assert.equal(detectDelimiter("name,amount\nfoo,1\nbar,2"), ",");
	assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
	assert.equal(detectDelimiter('"Smith, John";12\n"Jones, Paul";3'), ";");
	assert.equal(detectDelimiter("a single column\nwithout delimiter"), ",");
});

// RFC 4180: doubled quotes, delimiter and line break inside a field, CRLF.
test("CSV parsing", () => {
	assert.deepEqual(parseCsv('a;b\r\n"x;y";"he said ""yes"""\r\n"line\nbreak";2\r\n', ";"), {
		rows: [
			["a", "b"],
			["x;y", 'he said "yes"'],
			["line\nbreak", "2"],
		],
		totalRows: 3,
		truncated: false,
	});
});

test("beyond maxRows, rows are counted without being kept", () => {
	const many = Array.from({ length: 10 }, (_, i) => `${i},v${i}`).join("\n");
	const cut = parseCsv(many, ",", 4);
	assert.equal(cut.rows.length, 4);
	assert.equal(cut.totalRows, 10);
	assert.equal(cut.truncated, true);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
