// Apercu des documents Word (.docx) dans la visionneuse, et pieces jointes au type faux.
// Hugo le 24/11/2026 : 874 docx recus sans apercu ; pdf et png declares en
// application/x-file-download, application/octetstream... qui ne s'ouvraient pas.
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/word-preview.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentUrls } from "../lib/attachment-links";
import { effectiveType, servedTypeOverride } from "../lib/attachment-type";
import { canPreviewWord, safeDocUrl, WORD_PREVIEW_MAX_BYTES } from "../lib/word-preview";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";
const source = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok   ${label}`);
	} catch (e) {
		failures++;
		console.error(`FAIL ${label}\n`, e);
	}
};

test("docx reconnu par extension ou par type, jamais doc ni odt", () => {
	assert.equal(canPreviewWord({ filenameOriginal: "Contrat.DOCX", sizeBytes: 10 }), true);
	assert.equal(
		canPreviewWord({ filenameOriginal: "sans-nom", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
		true,
	);
	assert.equal(canPreviewWord({ filenameOriginal: "a.doc", contentType: "application/msword" }), false);
	assert.equal(canPreviewWord({ filenameOriginal: "a.odt" }), false);
	assert.equal(canPreviewWord({ filenameOriginal: "a.docx", sizeBytes: WORD_PREVIEW_MAX_BYTES + 1 }), false);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.docx", sizeBytes: 10 }).wordUrl, `/api/attachments/${ID}?mode=content`);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.pdf" }).wordUrl, undefined);
});

test("octets du docx servis par la route content, rendu isole et nettoye", () => {
	assert.match(source("app/api/attachments/[id]/route.ts"), /canPreviewWord\(attachment\)/);
	const viewer = source("components/k/word-preview.tsx");
	assert.match(viewer, /attachShadow/);
	assert.match(viewer, /renderAltChunks: false/);
	assert.match(viewer, /sanitize\(body\)/);
	assert.match(source("components/k/attachments.tsx"), /<WordPreview/);
	assert.match(source("components/mailbox/default/message-attachments.tsx"), /a\.wordUrl/);
});

test("liens du document : web et mail seulement ; images : celles du document seulement", () => {
	assert.equal(safeDocUrl("https://ss2i.fr", "href"), "https://ss2i.fr");
	assert.equal(safeDocUrl("mailto:a@b.fr", "href"), "mailto:a@b.fr");
	assert.equal(safeDocUrl("#_Toc1", "href"), "#_Toc1");
	assert.equal(safeDocUrl("javascript:alert(1)", "href"), null);
	assert.equal(safeDocUrl(" JavaScript:alert(1)", "href"), null);
	assert.equal(safeDocUrl("file:///C:/x", "href"), null);
	assert.equal(safeDocUrl("blob:https://mail.ss2i.ca/1", "src"), "blob:https://mail.ss2i.ca/1");
	assert.equal(safeDocUrl("data:image/png;base64,AA", "src"), "data:image/png;base64,AA");
	assert.equal(safeDocUrl("https://pixel.example/t.gif", "src"), null);
	assert.equal(safeDocUrl("data:text/html,<script>", "src"), null);
});

test("type generique ou faux remplace par celui de l'extension", () => {
	assert.equal(effectiveType("application/x-file-download", "facture.pdf"), "application/pdf");
	assert.equal(effectiveType("application/octetstream", "facture.pdf"), "application/pdf");
	assert.equal(effectiveType("pdf", "facture.pdf"), "application/pdf");
	assert.equal(effectiveType("text/x-moz-deleted", "facture.pdf"), "application/pdf");
	assert.equal(effectiveType("application/applefile", "photo.jpg"), "image/jpeg");
	assert.equal(effectiveType("", "photo.png"), "image/png");
	// Un type parlant reste la reference, meme si l'extension dit autre chose.
	assert.equal(effectiveType("image/png", "logo.jpg"), "image/png");
	assert.equal(effectiveType("application/octet-stream", "sans-extension"), "application/octet-stream");
});

test("type impose a S3 seulement pour un type generique, jamais HTML ni SVG", () => {
	assert.equal(servedTypeOverride("application/x-file-download", "facture.pdf"), "application/pdf");
	assert.equal(servedTypeOverride("application/pdf", "facture.pdf"), undefined);
	assert.equal(servedTypeOverride("application/octet-stream", "page.html"), undefined);
	assert.equal(servedTypeOverride("application/octet-stream", "dessin.svg"), undefined);
	assert.equal(servedTypeOverride("application/octet-stream", "a.exe"), undefined);
	const route = source("app/api/attachments/[id]/route.ts");
	assert.match(route, /mode === "open" && servedType \? \{ ResponseContentType: servedType \}/);
	assert.match(source("components/mailbox/default/editor/editor-attachment-item.tsx"), /effectiveType\(ct, name\)/);
});

if (failures) process.exit(1);
