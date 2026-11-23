// In an open mail, "a" archives and "e" deletes even when the last message of the thread is a
// reply that just left and still waits in the Outbox. The bottom row (Reply, Forward, Archive,
// Delete) is rendered only under the last message, and not while its editor is open: with a
// pending draft last, it no longer exists and the shortcut, which looked for the button by its
// "Archive" text, found nothing. It now aims at the bar button of a message, marked
// data-k-shortcut, and picks the bar of the message being read, not the first of a long thread.
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/open-mail-archive-shortcut.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}\n${(e as Error).stack}`);
	}
}

const WEB = join(__dirname, "..");
const code = (p: string) =>
	readFileSync(join(WEB, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("message bar: Archive and Delete buttons marked open-archive / open-delete", () => {
	const r = code("components/mailbox/default/email-renderer.tsx");
	assert.match(r, /aria-label="Archive"[^>]*data-k-shortcut="open-archive"|data-k-shortcut="open-archive"[^>]*aria-label="Archive"/);
	assert.match(r, /aria-label="Delete"[^>]*data-k-shortcut="open-delete"|data-k-shortcut="open-delete"[^>]*aria-label="Delete"/);
});

test("script: in a mail, the marked bar button of the message being read, then the text fallback", () => {
	const sh = code("public/keyboard-shortcuts.js");
	const m = sh.match(/const onMailOrSelection = \(label\) => \{([\s\S]*?)\n  \};/);
	assert.ok(m, "function onMailOrSelection");
	const f = m![1];
	assert.match(f, /inOpenMail\(\)/);
	assert.match(f, /open-delete/);
	assert.match(f, /open-archive/);
	assert.match(f, /barOfReadMessage\(/, "visible bar button, never the one of the list");
	assert.ok(f.indexOf("open-") < f.indexOf("click(label)"), "the marked button before the search by text");
});

const raw = readFileSync(join(WEB, "public/keyboard-shortcuts.js"), "utf8");
const src = raw.match(/const pickReadBar = (\([^)]*\) => \{[\s\S]*?\n  \});/);
test("pickReadBar exists in the script", () => assert.ok(src, "function pickReadBar"));
const pick: (tops: number[], high: number, low: number) => number = src
	? new Function(`return ${src[1]}`)()
	: () => 0;

test("the highest visible bar, not the one of the first message", () => {
	// 5 messages, bars at -2650, -1700, 433, 1300, 2200; screen from 74 to 894.
	assert.equal(pick([-2650, -1700, 433, 1300, 2200], 74, 894), 2);
});
test("no bar on screen: the one of the message whose body is read (the last one above)", () => {
	assert.equal(pick([-2650, -1700, 1300], 74, 894), 1);
});
test("bar under the sticky top bar: counted above, not visible", () => {
	assert.equal(pick([-500, 40, 1300], 74, 894), 1);
});
test("single message thread, or everything below: the only or the first one", () => {
	assert.equal(pick([169], 74, 894), 0);
	assert.equal(pick([1000, 2000], 74, 894), 0);
	assert.equal(pick([], 74, 894), -1);
});

if (failed) {
	console.error(`${failed} test(s) failed`);
	process.exit(1);
}
