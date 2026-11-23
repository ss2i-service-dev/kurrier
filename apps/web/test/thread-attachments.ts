// Attachments of a whole thread, brought up to the top of the conversation.
// From the repository root:
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
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

test("single message: its attachment is brought up too", () => {
	assert.deepEqual(ids(selectThreadAttachments([{ id: "m1" }], [file("a", "m1", "a.pptx")])), ["a"]);
});

test("newest to oldest", () => {
	const list = selectThreadAttachments([{ id: "m1" }, { id: "m2" }], [file("a", "m1", "a.pdf"), file("b", "m2", "b.pdf")]);
	assert.deepEqual(ids(list), ["b", "a"]);
});

test("file sent back: once, most recent version", () => {
	const byName = selectThreadAttachments([{ id: "m1" }, { id: "m2" }], [file("a", "m1", "Quote.pdf"), file("b", "m2", "quote.PDF")]);
	assert.deepEqual(ids(byName), ["b"]);
	const byContent = selectThreadAttachments(
		[{ id: "m1" }, { id: "m2" }],
		[file("a", "m1", "v1.pdf", { checksum: "x" }), file("b", "m2", "v2.pdf", { checksum: "x" })],
	);
	assert.deepEqual(ids(byContent), ["b"]);
});

test("same name, different size: two files", () => {
	const list = selectThreadAttachments([{ id: "m1" }, { id: "m2" }], [file("a", "m1", "d.pdf"), file("b", "m2", "d.pdf", { sizeBytes: 200 })]);
	assert.deepEqual(ids(list), ["b", "a"]);
});

test("drafts and messages outside the thread are ignored", () => {
	const list = selectThreadAttachments(
		[{ id: "m1", draft: true }, { id: "m2" }],
		[file("a", "m1", "a.pdf"), file("b", "m2", "b.pdf"), file("c", "other", "c.pdf")],
	);
	assert.deepEqual(ids(list), ["b"]);
});

test("image already visible in the body: not brought up", () => {
	const logo = file("logo", "m1", "logo.png", { contentType: "image/png", cid: "logo@x", isInline: true });
	const list = selectThreadAttachments([{ id: "m1", html: '<img src="cid:logo@x">' }], [logo, file("a", "m1", "a.pdf")]);
	assert.deepEqual(ids(list), ["a"]);
});

test("block present at the top of the three thread pages", () => {
	const mail = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/[mailboxSlug]";
	for (const path of ["components/k/thread-page.tsx", `${mail}/threads/[threadId]/page.tsx`, `${mail}/@thread/(.)threads/[threadId]/page.tsx`]) {
		assert.match(readFileSync(join(web, path), "utf8"), /<ThreadAttachments/, path);
	}
});

test("thread block: type badge like the mail thumbnails", () => {
	const source = readFileSync(join(web, "components/mailbox/default/message-attachments.tsx"), "utf8");
	assert.match(source, /badgeFor\(name, kind\)\.label/);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
