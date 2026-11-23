// No unread counter on the folders of what you wrote yourself ("Sent (4)" means nothing). Same
// idea as the Trash and the Archive.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/folder-unread-counts.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_UNREAD_COUNT_KINDS, showsUnreadCount, showsSidebarCount } from "../lib/folder-unread-counts";

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

// With the option "Number of drafts" (prefShowDraftsCount), Drafts shows its number of drafts
// (fetchDraftCounts, pending sends excluded), not unread messages. Off by default: Drafts stays
// without a counter. The other folders of the list never change.
test("Drafts shows its number of drafts in the sidebar only with the option on", () => {
	assert.equal(showsSidebarCount("drafts"), false);
	assert.equal(showsSidebarCount("drafts", false), false);
	assert.equal(showsSidebarCount("drafts", true), true);
	for (const on of [false, true]) {
		for (const k of ["sent", "outbox", "archive", "trash"]) assert.equal(showsSidebarCount(k, on), false, k);
		for (const k of ["inbox", "spam", "custom"]) assert.equal(showsSidebarCount(k, on), true, k);
	}
});

test("the option is stored per user, off by default, read by the root layout and set in the settings", () => {
	const action = src("lib/actions/drafts-count.ts");
	assert.match(action, /prefShowDraftsCount/);
	assert.match(action, /coalesce\(\([^)]*prefShowDraftsCount[^)]*\)::boolean, false\)/);
	assert.match(src("app/layout.tsx"), /showDraftsCountEnabled\(\)/);
	assert.match(src("app/layout.tsx"), /showDraftsCount=\{showDraftsCount\}/);
	assert.match(src("components/k/ui-context.tsx"), /showDraftsCount = false/);
	assert.match(src("components/mailbox/settings/settings-unread-panel.tsx"), /setShowDraftsCountEnabled/);
	assert.match(
		src("app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/settings/page.tsx"),
		/showDraftsCount=\{showDraftsCount\}/,
	);
});

test("the sidebars fed by fetchDraftCounts apply showsSidebarCount with the option", () => {
	for (const p of [
		"components/dashboard/identity-mailboxes-list.tsx",
		"components/k/sidebar-nav.tsx",
	]) {
		assert.match(src(p), /showsSidebarCount\(m\.kind, showDraftsCount\)/, p);
		assert.match(src(p), /useShowDraftsCount\(\)/, p);
	}
	// the older sidebar (mailbox-nav) only receives unread counts: Drafts stays without a counter
	assert.match(src("components/mailbox/default/mailbox-nav.tsx"), /showsUnreadCount\(/);
	for (const p of [
		"components/dashboard/workspaces/identity-mailboxes-list-wrapper.tsx",
		"components/k/sidebar-nav-wrapper.tsx",
	]) assert.match(src(p), /fetchDraftCounts\(\)/, p);
});

// Gmail does not set \Draft on its drafts over IMAP: the counter follows the folder list (one
// row per thread, pending sends apart), not the flag.
test("fetchDraftCounts counts the threads of the Drafts folder, without requiring the draft flag", () => {
	const s = src("lib/actions/drafts.ts");
	const body = s.slice(s.indexOf("export const fetchDraftCounts"), s.indexOf("export type FetchDraftCountsResult"));
	assert.ok(body.length > 0);
	assert.doesNotMatch(body, /eq\(messages\.draft, true\)/);
	assert.match(body, /count\(distinct \$\{messages\.threadId\}\)/);
	assert.match(body, /pendingSend/);
});

if (failed) {
	console.log(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nfolder-unread-counts: all tests pass");
