// List of the files of a received zip, displayed in the viewer. Nothing is decompressed: the
// route reads the end of the file by S3 ranges.
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/zip-listing.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentUrls } from "../lib/attachment-links";
import { canListZip, locateCentralDirectory, parseCentralDirectory, ZIP_TAIL_BYTES } from "../lib/zip-listing";

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

// Minimal zip written by hand (store method): local headers, central directory, end record.
type In = { name: Uint8Array; data: Uint8Array; utf8?: boolean; encrypted?: boolean; dir?: boolean };
function zip(files: In[], comment = "") {
	const le = (n: number, len: number) => Array.from({ length: len }, (_, i) => (n / 256 ** i) & 255);
	const local: number[] = [];
	const central: number[] = [];
	for (const f of files) {
		const flags = (f.utf8 ? 0x800 : 0) | (f.encrypted ? 1 : 0);
		const offset = local.length;
		// 2026-11-18 09:30:00 as a DOS date
		const time = (9 << 11) | (30 << 5);
		const date = ((2026 - 1980) << 9) | (11 << 5) | 18;
		local.push(...le(0x04034b50, 4), ...le(20, 2), ...le(flags, 2), ...le(0, 2), ...le(time, 2), ...le(date, 2));
		local.push(...le(0, 4), ...le(f.data.length, 4), ...le(f.data.length, 4), ...le(f.name.length, 2), ...le(0, 2));
		local.push(...f.name, ...f.data);
		central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(flags, 2), ...le(0, 2), ...le(time, 2));
		central.push(...le(date, 2), ...le(0, 4), ...le(f.data.length, 4), ...le(f.data.length, 4), ...le(f.name.length, 2));
		central.push(...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(f.dir ? 0x10 : 0, 4), ...le(offset, 4), ...f.name);
	}
	const c = new TextEncoder().encode(comment);
	const end = [...le(0x06054b50, 4), ...le(0, 4), ...le(files.length, 2), ...le(files.length, 2)];
	end.push(...le(central.length, 4), ...le(local.length, 4), ...le(c.length, 2), ...c);
	return new Uint8Array([...local, ...central, ...end]);
}
const enc = (s: string) => new TextEncoder().encode(s);

test("zip detection and link on the page", () => {
	assert.equal(canListZip({ filenameOriginal: "Invoices 2025.ZIP", contentType: "application/octet-stream" }), true);
	assert.equal(canListZip({ filenameOriginal: "documents", contentType: "application/x-zip-compressed" }), true);
	assert.equal(
		canListZip({ filenameOriginal: "offer.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
		false,
	);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.zip", contentType: "application/zip" }).zipUrl, `/api/attachments/${ID}?mode=listing`);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.pdf", contentType: "application/pdf" }).zipUrl, undefined);
});

const bytes = zip(
	[
		{ name: enc("Invoices/"), data: new Uint8Array(), utf8: true, dir: true },
		{ name: enc("Invoices/December €.pdf"), data: enc("0123456789"), utf8: true },
		// "Été.txt" in CP437 without the UTF-8 flag (Windows Explorer)
		{ name: new Uint8Array([0x90, 0x74, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: enc("abc") },
		{ name: enc("secret.txt"), data: enc("x"), encrypted: true },
	],
	"zip comment",
);
const tail = bytes.subarray(Math.max(0, bytes.length - ZIP_TAIL_BYTES));
const dir = locateCentralDirectory(tail, bytes.length);

test("the central directory is found from the last bytes only", () => {
	assert.ok(dir);
	assert.equal(dir.count, 4);
});

test("entries: names (UTF-8 and CP437), sizes, folders, encryption, date", () => {
	assert.ok(dir);
	const listing = parseCentralDirectory(bytes.subarray(dir.offset, dir.offset + dir.size));
	assert.equal(listing.total, 4);
	assert.equal(listing.truncated, false);
	assert.deepEqual(
		listing.entries.map((e) => [e.path, e.size, e.dir, e.encrypted]),
		[
			["Invoices/", 0, true, false],
			["Invoices/December €.pdf", 10, false, false],
			["Été.txt", 3, false, false],
			["secret.txt", 1, false, true],
		],
	);
	assert.equal(listing.entries[1].modified, "2026-11-18T09:30:00");
});

test("not a zip: null, no exception", () => {
	assert.equal(locateCentralDirectory(enc("not a zip"), 9), null);
});

test("beyond the cap, entries are counted without being kept", () => {
	assert.ok(dir);
	const capped = parseCentralDirectory(bytes.subarray(dir.offset, dir.offset + dir.size), 2);
	assert.equal(capped.entries.length, 2);
	assert.equal(capped.total, 4);
	assert.equal(capped.truncated, true);
});

test("the route reads by ranges, never the whole file", () => {
	const route = readFileSync(join(__dirname, "..", "app/api/attachments/[id]/route.ts"), "utf8");
	assert.match(route, /mode === "listing"/);
	assert.match(route, /`bytes=-\$\{ZIP_TAIL_BYTES\}`/);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
