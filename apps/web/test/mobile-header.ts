// Classic interface, mobile and desktop: the list action bar (select all, refresh, archive,
// delete, compose) disappeared on the first scroll. It was sticky at top-0, like the top bar
// (search, identity, z-50) that covered it: 74 px on desktop, 134 px on a 390 px screen where
// the search wrapped on three lines. It now sticks under the top bar, whose height is published
// in --mail-header-h; the top bar fits on one line on mobile, and a thread opened on mobile has
// a back bar.
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/mobile-header.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const VAR = "--mail-header-h";

test("the top bar publishes its height", () => {
	const header = src("components/mailbox/mailbox-search-header.tsx");
	assert.match(header, /<MailHeaderHeight \/>/);
	assert.match(header, /sticky top-0/);
	const comp = src("components/mailbox/mail-header-height.tsx");
	assert.ok(comp.includes(`"${VAR}"`), "variable name");
	assert.match(comp, /ResizeObserver/);
	assert.match(comp, /removeProperty\(MAIL_HEADER_VAR\)/, "variable removed outside the mail views");
});
test("the list action bar sticks under the top bar, not at top-0", () => {
	const list = src("components/mailbox/default/mail-list-header.tsx");
	assert.ok(list.includes(`sticky top-[var(${VAR},0px)]`));
	assert.doesNotMatch(list, /className="sticky top-0/);
});
test("the thread back bar (mobile) sticks under the top bar", () => {
	const slot = src("components/mailbox/default/thread-slot.tsx");
	assert.ok(slot.includes(`sticky top-[var(${VAR},0px)]`));
	assert.match(slot, /md:hidden/);
	assert.match(slot, /leaveThreadToList\(router/);
});
test("mobile: search on one line, identity reduced to the cog", () => {
	const search = src("components/mailbox/default/mailbox-search.tsx");
	assert.match(search, /min-w-0 flex-1[^"]*"/);
	assert.match(search, /truncate text-sm/);
	const id = src("components/mailbox/settings/identity-settings.tsx");
	assert.match(id, /shrink-0 md:hidden/);
	assert.match(id, /hidden shrink-0 md:block/);
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nmobile-header: all green");
