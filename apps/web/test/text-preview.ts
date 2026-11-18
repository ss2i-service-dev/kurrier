// Apercu des pieces jointes texte et CSV dans la visionneuse.
// Samuel le 18/11/2026 : « on peut quand meme faire mieux niveau apercu non ? » sur
// heb-2025-sous-traitance-aurelien.csv, ouvert sur une page blanche (iframe sur l'URL S3 :
// Chrome telecharge un text/csv au lieu de l'afficher).
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
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

// Fichiers concernes : par extension (Outlook envoie souvent un CSV en application/vnd.ms-excel
// ou application/octet-stream) ou par type text/*. Le HTML et le SVG restent dans l'iframe S3.
assert.equal(canPreviewText({ filenameOriginal: "heb-2025.csv", contentType: "text/csv", sizeBytes: 3000 }), true);
assert.equal(canPreviewText({ filenameOriginal: "export.CSV", contentType: "application/vnd.ms-excel", sizeBytes: 10 }), true);
assert.equal(canPreviewText({ filenameOriginal: "export.csv", contentType: "application/octet-stream", sizeBytes: 10 }), true);
assert.equal(canPreviewText({ filenameOriginal: "notes.txt", contentType: "text/plain", sizeBytes: 10 }), true);
assert.equal(canPreviewText({ filenameOriginal: "data.json", contentType: "application/json", sizeBytes: 10 }), true);
assert.equal(canPreviewText({ filenameOriginal: "sans-extension", contentType: "text/plain", sizeBytes: 10 }), true);
assert.equal(canPreviewText({ filenameOriginal: "page.html", contentType: "text/html", sizeBytes: 10 }), false);
assert.equal(canPreviewText({ filenameOriginal: "logo.svg", contentType: "image/svg+xml", sizeBytes: 10 }), false);
assert.equal(canPreviewText({ filenameOriginal: "rapport.pdf", contentType: "application/pdf", sizeBytes: 10 }), false);
assert.equal(canPreviewText({ filenameOriginal: "invite.ics", contentType: "text/calendar", sizeBytes: 10 }), false);
assert.equal(
	canPreviewText({ filenameOriginal: "gros.csv", contentType: "text/csv", sizeBytes: TEXT_PREVIEW_MAX_BYTES + 1 }),
	false,
);

assert.equal(isTabular({ filenameOriginal: "a.csv", contentType: "application/octet-stream" }), true);
assert.equal(isTabular({ filenameOriginal: "a.tsv", contentType: null }), true);
assert.equal(isTabular({ filenameOriginal: "a", contentType: "text/csv; charset=utf-8" }), true);
assert.equal(isTabular({ filenameOriginal: "a.txt", contentType: "text/plain" }), false);

// Les liens de la page portent l'URL des octets pour un fichier texte, pas pour un PDF.
assert.equal(
	attachmentUrls({ id: ID, filenameOriginal: "a.csv", contentType: "text/csv", sizeBytes: 10 }).textUrl,
	`/api/attachments/${ID}?mode=content`,
);
assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }).textUrl, undefined);
assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.csv", contentType: "text/csv", sizeBytes: 10 }).contentUrl, undefined);

// Encodage : UTF-8 (BOM retire), sinon Windows-1252 (export Excel francais), UTF-16 avec BOM.
const enc = new TextEncoder();
assert.deepEqual(decodeText(enc.encode("Libellé;Montant")), { text: "Libellé;Montant", encoding: "UTF-8" });
assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("é")])).text, "é");
assert.deepEqual(decodeText(new Uint8Array([0x4c, 0x69, 0x62, 0x65, 0x6c, 0x6c, 0xe9, 0x20, 0x80])), {
	text: "Libellé €",
	encoding: "Windows-1252",
});
assert.deepEqual(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00])), { text: "Aé", encoding: "UTF-16LE" });

// Separateur : point-virgule (Excel francais), virgule, tabulation ; ignore dans les guillemets.
assert.equal(detectDelimiter("Nom;Montant\nDupont;12,50\nMartin;3,00"), ";");
assert.equal(detectDelimiter("name,amount\nfoo,1\nbar,2"), ",");
assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
assert.equal(detectDelimiter('"Dupont, Jean";12\n"Martin, Paul";3'), ";");
assert.equal(detectDelimiter("une seule colonne\nsans separateur"), ",");

// Analyse RFC 4180 : guillemets doubles, separateur et saut de ligne dans un champ, CRLF.
assert.deepEqual(parseCsv('a;b\r\n"x;y";"il dit ""oui"""\r\n"ligne\nsuivante";2\r\n', ";"), {
	rows: [
		["a", "b"],
		["x;y", 'il dit "oui"'],
		["ligne\nsuivante", "2"],
	],
	totalRows: 3,
	truncated: false,
});
// Au-dela de maxRows, on compte les lignes sans les garder.
const many = Array.from({ length: 10 }, (_, i) => `${i},v${i}`).join("\n");
const cut = parseCsv(many, ",", 4);
assert.equal(cut.rows.length, 4);
assert.equal(cut.totalRows, 10);
assert.equal(cut.truncated, true);

console.log("text-preview : ok");
