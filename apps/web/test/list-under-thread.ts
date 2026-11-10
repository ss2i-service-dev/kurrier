// Classic interface: option not to display the folder list under an open thread. On soft
// navigation, the layout keeps the list (children) under the thread of the @thread slot: the
// open thread, often the most recent, reappeared on the first row. Per-user option
// "Hide the folder list under an open conversation", off by default (original behaviour).
// On a direct load of the URL of a thread, children IS the thread: it must never be hidden,
// so the list is hidden in the folder page (ClassicPage) and not the {children} of the layout.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/list-under-thread.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listIsHidden, pathHasThread, parseListUnderThread } from "../lib/list-under-thread";

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

const base = "/en/w/w1/dashboard/mail/i1/inbox";

test("the URL of a thread is recognised, the one of the folder is not", () => {
	assert.equal(pathHasThread(`${base}/threads/abc-123`), true);
	assert.equal(pathHasThread(`${base}/threads/abc-123/`), true);
	assert.equal(pathHasThread(base), false);
	assert.equal(pathHasThread(`${base}?page=2`), false);
	assert.equal(pathHasThread(`${base}/threads/`), false);
	assert.equal(pathHasThread(null), false);
	assert.equal(pathHasThread(undefined), false);
});
test("hidden: the list disappears under a thread, comes back without one", () => {
	assert.equal(listIsHidden("hidden", `${base}/threads/abc`), true);
	assert.equal(listIsHidden("hidden", base), false);
});
test("shown (default): original behaviour, the list always stays", () => {
	assert.equal(listIsHidden("shown", `${base}/threads/abc`), false);
	assert.equal(listIsHidden("shown", base), false);
});
test("unknown or missing value: shown", () => {
	assert.equal(parseListUnderThread(undefined), "shown");
	assert.equal(parseListUnderThread(null), "shown");
	assert.equal(parseListUnderThread("anything"), "shown");
	assert.equal(parseListUnderThread("shown"), "shown");
	assert.equal(parseListUnderThread("hidden"), "hidden");
});

const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => strip(readFileSync(join(__dirname, "..", p), "utf8"));
const dir = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]";

test("action: stored in workspaces.meta.prefListUnderThread[userId], no table", () => {
	const src = read("lib/actions/list-under-thread.ts");
	assert.ok(/^"use server"/.test(src.trim()), "not a server action");
	assert.ok(/prefListUnderThread/.test(src), "meta key missing");
	assert.ok(/export async function listUnderThread\(/.test(src), "read missing");
	assert.ok(/export async function setListUnderThread\(/.test(src), "write missing");
	assert.ok(/revalidatePath\(/.test(src), "no revalidation");
	assert.ok(!/pgTable|create table/i.test(src), "must not create a table");
});
test("component: path by usePathname (not useParams), renders null when hidden", () => {
	const p = "components/mailbox/default/list-slot.tsx";
	assert.ok(existsSync(join(__dirname, "..", p)), "list-slot.tsx missing");
	const src = read(p);
	assert.ok(/"use client"/.test(src));
	assert.ok(/usePathname\(/.test(src), "usePathname expected");
	assert.ok(!/useParams\(/.test(src), "useParams forbidden (old threadId in the preserved slot)");
	assert.ok(/listIsHidden\(/.test(src) && /return null/.test(src), "the list is not hidden");
});
test("folder page: only the classic list is wrapped, the modern interface untouched", () => {
	const src = read(`${dir}/[mailboxSlug]/page.tsx`);
	const classic = src.slice(src.indexOf("async function ClassicPage"), src.indexOf("async function ModernPage"));
	const modern = src.slice(src.indexOf("async function ModernPage"), src.indexOf("async function Page("));
	assert.ok(/<ListSlot\b/.test(classic) && /<\/ListSlot>/.test(classic), "ClassicPage does not use ListSlot");
	assert.ok(/listUnderThread\(\)/.test(classic), "ClassicPage does not read the option");
	assert.ok(!/ListSlot|listUnderThread/.test(modern), "the modern interface must not change");
});
test("layout: {children} is not hidden (on a direct load it is the thread)", () => {
	const src = read(`${dir}/[mailboxSlug]/layout.tsx`);
	assert.ok(!/ListSlot/.test(src), "the layout must not hide children");
	assert.ok(/MailboxSearchHeader/.test(src), "search header kept");
});
test("settings: switch \"Hide the folder list under an open conversation\" wired", () => {
	const card = read("components/mailbox/settings/settings-unread-panel.tsx");
	assert.ok(/Hide the folder list under an open conversation/.test(card), "label missing");
	assert.ok(/setListUnderThread\(/.test(card), "write not wired");
	const page = read(`${dir}/settings/page.tsx`);
	assert.ok(/listUnderThread\(\)/.test(page), "the settings page does not read the option");
});

if (failures) {
	console.log(`\n${failures} failing test(s)`);
	process.exit(1);
}
console.log("\nall tests pass");
