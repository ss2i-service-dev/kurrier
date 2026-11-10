// Classic interface: the pagination arrows under the list did nothing. Cause: total = count / 50,
// not rounded (2 threads -> 0.04 page: next arrow active, a click towards a page < 1 ignored), and
// count counted the messages of the folder, not the listed threads (empty last pages on a large
// folder). The number of pages now comes from pageCount(), over the number of visible threads
// (same snooze filter as the list).
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/mail-pagination.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageCount, clampPage } from "../lib/mail-pagination";

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

test("whole number of pages, at least one", () => {
	assert.equal(pageCount(0, 50), 1);
	assert.equal(pageCount(2, 50), 1);
	assert.equal(pageCount(50, 50), 1);
	assert.equal(pageCount(51, 50), 2);
	assert.equal(pageCount(1234, 50), 25);
	assert.equal(pageCount(Number.NaN, 50), 1);
});

test("page brought back between 1 and the last", () => {
	assert.equal(clampPage(0, 3), 1);
	assert.equal(clampPage(Number.NaN, 3), 1);
	assert.equal(clampPage(2, 3), 2);
	assert.equal(clampPage(9, 3), 3);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("the classic pagination uses pageCount, no longer count / 50", () => {
	const src = read("components/mailbox/default/mail-pagination.tsx");
	assert.ok(src.includes("pageCount("), "mail-pagination.tsx must call pageCount");
	assert.ok(!/count\s*\/\s*50/.test(src), "no more count / 50");
});

test("fetchMailbox count counts the visible threads, not the messages", () => {
	const src = read("lib/actions/mailbox.ts");
	const start = src.indexOf("export const fetchMailbox = cache(");
	assert.ok(start >= 0, "fetchMailbox not found");
	const body = src.slice(start, src.indexOf("export type FetchMailboxResult", start));
	assert.ok(body.includes(".from(mailboxThreads)"), "the count must be on mailboxThreads");
	assert.ok(body.includes("snoozedUntil"), "same snooze filter as fetchMailboxThreads");
	assert.ok(!/\.from\(messages\)/.test(body), "no more count on messages");
});

if (failures) {
	console.log(`\n${failures} failing test(s)`);
	process.exit(1);
}
console.log("\nall tests pass");
