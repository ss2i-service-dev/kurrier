// Pieces jointes reelles (Samuel le 10/11 : « tous les mails ont des pieces jointes quasiment des
// qu'il y a une signature image dedans, alors qu'en fait, il n'y a pas de piece jointe »).
// Une image integree au corps (cid ou disposition inline) n'est pas une piece jointe ; un PDF ou
// tout autre fichier en est une, meme quand le client de messagerie lui donne un Content-ID.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/real-attachments.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasRealAttachments, isRealAttachment, REAL_ATTACHMENT_SQL } from "../../../packages/common/src/real-attachments";

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

test("image de signature referencee par cid : pas une piece jointe", () => {
	assert.equal(isRealAttachment({ contentType: "image/png", cid: "logo@sig", contentDisposition: "inline" }), false);
	assert.equal(isRealAttachment({ contentType: "image/jpeg", cid: "x", contentDisposition: "attachment" }), false);
});

test("image en disposition inline sans cid : pas une piece jointe", () => {
	assert.equal(isRealAttachment({ contentType: "IMAGE/GIF", contentDisposition: "inline" }), false);
	assert.equal(isRealAttachment({ contentType: "image/png", isInline: true }), false);
});

test("image jointe explicitement : piece jointe", () => {
	assert.equal(isRealAttachment({ contentType: "image/jpeg", contentDisposition: "attachment" }), true);
});

test("PDF ou autre fichier : piece jointe, meme avec un cid (Apple Mail, Outlook)", () => {
	assert.equal(isRealAttachment({ contentType: "application/pdf", contentDisposition: "attachment" }), true);
	assert.equal(isRealAttachment({ contentType: "application/pdf", cid: "abc", contentDisposition: "inline" }), true);
	assert.equal(isRealAttachment({ contentType: null }), true);
});

test("hasRealAttachments : un message avec seulement une signature n'a pas de piece jointe", () => {
	assert.equal(hasRealAttachments([{ contentType: "image/png", cid: "a" }, { contentType: "image/jpeg", cid: "b" }]), false);
	assert.equal(hasRealAttachments([{ contentType: "image/png", cid: "a" }, { contentType: "application/pdf" }]), true);
	assert.equal(hasRealAttachments(undefined), false);
	assert.equal(hasRealAttachments([]), false);
});

test("regle SQL alignee (alias a de message_attachments)", () => {
	assert.match(REAL_ATTACHMENT_SQL, /ilike 'image\/%'/);
	assert.match(REAL_ATTACHMENT_SQL, /a\.is_inline or a\.cid is not null/);
});

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("le worker calcule has_attachments avec hasRealAttachments", () => {
	const src = read("apps/worker/lib/message-payload-parser.ts");
	assert.match(src, /hasAttachments: hasRealAttachments\(parsed\.attachments\)/);
});

test("la nouvelle interface applique la meme regle", () => {
	const src = read("apps/web/lib/actions/k-threads.ts");
	assert.doesNotMatch(src, /and not a\.is_inline\n/);
	assert.match(src, /REAL_ATTACHMENT_SQL/);
});

test("une migration recalcule l'existant (messages puis fils)", () => {
	const sqlText = read("db/init/migrations/ss2i_007_migration.sql");
	assert.match(sqlText, /update\s+messages/i);
	assert.match(sqlText, /update\s+mailbox_threads/i);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nreal-attachments : tous les tests passent");
