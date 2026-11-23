// Real attachments. An image embedded in the body (cid or inline disposition) is not an
// attachment; a PDF or any other file is one, even when the mail client gives it a Content-ID.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/real-attachments.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasRealAttachments, isRealAttachment, REAL_ATTACHMENT_SQL } from "../../../packages/common/src/real-attachments";

let failed = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failed++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

test("signature image referenced by cid: not an attachment", () => {
	assert.equal(isRealAttachment({ contentType: "image/png", cid: "logo@sig", contentDisposition: "inline" }), false);
	assert.equal(isRealAttachment({ contentType: "image/jpeg", cid: "x", contentDisposition: "attachment" }), false);
});

test("inline image without a cid: not an attachment", () => {
	assert.equal(isRealAttachment({ contentType: "IMAGE/GIF", contentDisposition: "inline" }), false);
	assert.equal(isRealAttachment({ contentType: "image/png", isInline: true }), false);
});

test("image attached explicitly: an attachment", () => {
	assert.equal(isRealAttachment({ contentType: "image/jpeg", contentDisposition: "attachment" }), true);
});

test("PDF or any other file: an attachment, even with a cid (Apple Mail, Outlook)", () => {
	assert.equal(isRealAttachment({ contentType: "application/pdf", contentDisposition: "attachment" }), true);
	assert.equal(isRealAttachment({ contentType: "application/pdf", cid: "abc", contentDisposition: "inline" }), true);
	assert.equal(isRealAttachment({ contentType: null }), true);
});

test("hasRealAttachments: a message with only a signature has no attachment", () => {
	assert.equal(hasRealAttachments([{ contentType: "image/png", cid: "a" }, { contentType: "image/jpeg", cid: "b" }]), false);
	assert.equal(hasRealAttachments([{ contentType: "image/png", cid: "a" }, { contentType: "application/pdf" }]), true);
	assert.equal(hasRealAttachments(undefined), false);
	assert.equal(hasRealAttachments([]), false);
});

test("SQL rule aligned (alias a of message_attachments)", () => {
	assert.match(REAL_ATTACHMENT_SQL, /ilike 'image\/%'/);
	assert.match(REAL_ATTACHMENT_SQL, /a\.is_inline or a\.cid is not null/);
});

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("the worker computes has_attachments with hasRealAttachments", () => {
	const src = read("apps/worker/lib/message-payload-parser.ts");
	assert.match(src, /hasAttachments: hasRealAttachments\(parsed\.attachments\)/);
});

test("the three-column interface applies the same rule", () => {
	const src = read("apps/web/lib/actions/k-threads.ts");
	assert.doesNotMatch(src, /and not a\.is_inline\n/);
	assert.match(src, /REAL_ATTACHMENT_SQL/);
});

test("a migration recomputes the existing data (messages, then threads)", () => {
	const sqlText = read("db/init/migrations/community_005_migration.sql");
	assert.match(sqlText, /update\s+messages/i);
	assert.match(sqlText, /update\s+mailbox_threads/i);
});

if (failed) {
	console.log(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nreal-attachments: all tests pass");
