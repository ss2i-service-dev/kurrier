// Pieces jointes de tout un fil, remontees en haut de la conversation (Hugo le 18/11/2026).
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/thread-attachments.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectThreadAttachments } from "../lib/thread-attachments";

const web = join(__dirname, "..");
const ids = (list: { id: string }[]) => list.map((a) => a.id);
const file = (id: string, messageId: string, filenameOriginal: string, extra = {}) => ({
	id,
	messageId,
	filenameOriginal,
	contentType: "application/pdf",
	sizeBytes: 100,
	...extra,
});

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

test("message unique : sa piece jointe remonte aussi", () => {
	assert.deepEqual(ids(selectThreadAttachments([{ id: "m1" }], [file("a", "m1", "a.pptx")])), ["a"]);
});

test("du plus recent au plus ancien", () => {
	const list = selectThreadAttachments([{ id: "m1" }, { id: "m2" }], [file("a", "m1", "a.pdf"), file("b", "m2", "b.pdf")]);
	assert.deepEqual(ids(list), ["b", "a"]);
});

test("fichier renvoye : une seule fois, version la plus recente", () => {
	const byName = selectThreadAttachments([{ id: "m1" }, { id: "m2" }], [file("a", "m1", "Devis.pdf"), file("b", "m2", "devis.PDF")]);
	assert.deepEqual(ids(byName), ["b"]);
	const byContent = selectThreadAttachments(
		[{ id: "m1" }, { id: "m2" }],
		[file("a", "m1", "v1.pdf", { checksum: "x" }), file("b", "m2", "v2.pdf", { checksum: "x" })],
	);
	assert.deepEqual(ids(byContent), ["b"]);
});

test("meme nom, taille differente : deux fichiers", () => {
	const list = selectThreadAttachments([{ id: "m1" }, { id: "m2" }], [file("a", "m1", "d.pdf"), file("b", "m2", "d.pdf", { sizeBytes: 200 })]);
	assert.deepEqual(ids(list), ["b", "a"]);
});

test("brouillons et messages hors fil ignores", () => {
	const list = selectThreadAttachments([{ id: "m1", draft: true }, { id: "m2" }], [file("a", "m1", "a.pdf"), file("b", "m2", "b.pdf"), file("c", "autre", "c.pdf")]);
	assert.deepEqual(ids(list), ["b"]);
});

test("image deja visible dans le corps : pas remontee", () => {
	const logo = file("logo", "m1", "logo.png", { contentType: "image/png", cid: "logo@x", isInline: true });
	const list = selectThreadAttachments([{ id: "m1", html: '<img src="cid:logo@x">' }], [logo, file("a", "m1", "a.pdf")]);
	assert.deepEqual(ids(list), ["a"]);
});

test("bloc present en haut des trois pages de fil", () => {
	const mail = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/[mailboxSlug]";
	for (const path of ["components/k/thread-page.tsx", `${mail}/threads/[threadId]/page.tsx`, `${mail}/@thread/(.)threads/[threadId]/page.tsx`]) {
		assert.match(readFileSync(join(web, path), "utf8"), /<ThreadAttachments/, path);
	}
});

test("bloc du fil : pastille de type comme les vignettes des mails", () => {
	assert.match(readFileSync(join(web, "components/mailbox/default/message-attachments.tsx"), "utf8"), /badgeFor\(name, kind\)\.label/);
});

if (failures > 0) {
	console.error(`${failures} test(s) en echec`);
	process.exit(1);
}
