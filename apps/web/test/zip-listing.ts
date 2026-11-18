// Liste des fichiers d'un zip recu, dans la visionneuse.
// Samuel le 18/11/2026 : « les zip il faut un apercu de la liste des fichiers qu'ils contiennent ».
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/zip-listing.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentUrls } from "../lib/attachment-links";
import { canListZip, locateCentralDirectory, parseCentralDirectory, ZIP_TAIL_BYTES } from "../lib/zip-listing";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";

// Zip minimal ecrit a la main (methode store) : en-tetes locaux, repertoire central, fin.
type In = { name: Uint8Array; data: Uint8Array; utf8?: boolean; encrypted?: boolean; dir?: boolean };
function zip(files: In[], comment = "") {
	const le = (n: number, len: number) => Array.from({ length: len }, (_, i) => (n / 256 ** i) & 255);
	const local: number[] = [];
	const central: number[] = [];
	for (const f of files) {
		const flags = (f.utf8 ? 0x800 : 0) | (f.encrypted ? 1 : 0);
		const offset = local.length;
		// 2026-11-18 09:30:00 en date DOS
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

assert.equal(canListZip({ filenameOriginal: "Factures 2025.ZIP", contentType: "application/octet-stream" }), true);
assert.equal(canListZip({ filenameOriginal: "pieces", contentType: "application/x-zip-compressed" }), true);
assert.equal(canListZip({ filenameOriginal: "offre.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), false);
assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.zip", contentType: "application/zip" }).zipUrl, `/api/attachments/${ID}?mode=listing`);
assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.pdf", contentType: "application/pdf" }).zipUrl, undefined);

const bytes = zip(
	[
		{ name: enc("Factures/"), data: new Uint8Array(), utf8: true, dir: true },
		{ name: enc("Factures/Décembre €.pdf"), data: enc("0123456789"), utf8: true },
		// « Été.txt » en CP437 sans drapeau UTF-8 (Explorateur Windows)
		{ name: new Uint8Array([0x90, 0x74, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: enc("abc") },
		{ name: enc("secret.txt"), data: enc("x"), encrypted: true },
	],
	"commentaire du zip",
);

// Le serveur ne lit que la fin du fichier pour trouver le repertoire central.
const tail = bytes.subarray(Math.max(0, bytes.length - ZIP_TAIL_BYTES));
const dir = locateCentralDirectory(tail, bytes.length);
assert.ok(dir);
assert.equal(dir.count, 4);
const listing = parseCentralDirectory(bytes.subarray(dir.offset, dir.offset + dir.size));
assert.equal(listing.total, 4);
assert.equal(listing.truncated, false);
assert.deepEqual(
	listing.entries.map((e) => [e.path, e.size, e.dir, e.encrypted]),
	[
		["Factures/", 0, true, false],
		["Factures/Décembre €.pdf", 10, false, false],
		["Été.txt", 3, false, false],
		["secret.txt", 1, false, true],
	],
);
assert.equal(listing.entries[1].modified, "2026-11-18T09:30:00");

// Fin de repertoire introuvable (fichier tronque ou pas un zip) : null, pas d'exception.
assert.equal(locateCentralDirectory(enc("pas un zip"), 10), null);
// Au-dela du plafond, on compte sans garder.
const capped = parseCentralDirectory(bytes.subarray(dir.offset, dir.offset + dir.size), 2);
assert.equal(capped.entries.length, 2);
assert.equal(capped.total, 4);
assert.equal(capped.truncated, true);

// La route lit par plages, jamais tout le fichier.
const route = readFileSync(join(__dirname, "..", "app/api/attachments/[id]/route.ts"), "utf8");
assert.match(route, /mode === "listing"/);
assert.match(route, /`bytes=-\$\{ZIP_TAIL_BYTES\}`/);

console.log("zip-listing : ok");
