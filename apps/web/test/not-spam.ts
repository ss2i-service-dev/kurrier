// "Not spam" button in the open message: a message opened from the Spam folder can be
// moved back to the Inbox of its identity and the reader returns to the list.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/not-spam.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inboxIdForSpam } from "../lib/not-spam";

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

const boxes = [
	{ identity: { id: "i1" }, mailboxes: [{ id: "in1", kind: "inbox" }, { id: "sp1", kind: "spam" }, { id: "ar1", kind: "archive" }] },
	{ identity: { id: "i2" }, mailboxes: [{ id: "in2", kind: "inbox" }, { id: "sp2", kind: "spam" }] },
];

test("message open in Spam: Inbox of the same identity", () => {
	assert.equal(inboxIdForSpam(boxes, "sp1"), "in1");
	assert.equal(inboxIdForSpam(boxes, "sp2"), "in2");
});

test("outside Spam: no button", () => {
	assert.equal(inboxIdForSpam(boxes, "in1"), null);
	assert.equal(inboxIdForSpam(boxes, "ar1"), null);
	assert.equal(inboxIdForSpam(boxes, "unknown"), null);
});

test("identity without an Inbox or missing list: no button", () => {
	assert.equal(inboxIdForSpam([{ identity: { id: "i3" }, mailboxes: [{ id: "sp3", kind: "spam" }] }], "sp3"), null);
	assert.equal(inboxIdForSpam(null, "sp1"), null);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("Classic interface: button in the message bar, move to the Inbox then back to the list", () => {
	const src = read("components/mailbox/default/email-renderer.tsx");
	assert.match(src, /inboxIdForSpam\(/);
	assert.match(src, /moveToFolder\(/);
	assert.match(src, /aria-label="Not spam"/);
});

test("Three-column interface: button in the thread bar and notSpam action of the store", () => {
	assert.match(read("components/k/thread-toolbar.tsx"), /mailActions\.notSpam\(/);
	assert.match(read("components/k/mail-store.ts"), /notSpam\(/);
	assert.match(read("components/k/thread-page.tsx"), /inboxIdForSpam\(/);
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nnot-spam: all tests pass");
