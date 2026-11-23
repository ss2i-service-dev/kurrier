// No unread counter on the folders of what you wrote yourself ("Sent (4)" means nothing). Same
// idea as the Trash and the Archive.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/folder-unread-counts.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_UNREAD_COUNT_KINDS, showsUnreadCount } from "../lib/folder-unread-counts";

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

test("Sent, Outbox, Drafts, Archive and Trash: no counter", () => {
	for (const k of ["sent", "outbox", "drafts", "archive", "trash"]) {
		assert.equal(showsUnreadCount(k), false, k);
		assert.ok(NO_UNREAD_COUNT_KINDS.includes(k as any), k);
	}
});

test("Inbox, Spam and custom folders keep their counter", () => {
	for (const k of ["inbox", "spam", "custom"]) assert.equal(showsUnreadCount(k), true, k);
});

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("the server no longer computes the counter of these folders (all sidebars)", () => {
	assert.match(src("lib/actions/mailbox.ts"), /notInArray\(mailboxes\.kind, \[\.\.\.NO_UNREAD_COUNT_KINDS\]\)/);
});

test("the three sidebars apply the same rule", () => {
	for (const p of [
		"components/dashboard/identity-mailboxes-list.tsx",
		"components/k/sidebar-nav.tsx",
		"components/mailbox/default/mailbox-nav.tsx",
	]) assert.match(src(p), /showsUnreadCount\(/, p);
});

if (failed) {
	console.log(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nfolder-unread-counts: all tests pass");
