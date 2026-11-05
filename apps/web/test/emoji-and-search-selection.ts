// This test is run by Dockerfile.web before the build: red = no image.
//   1) Emoji from Outlook: Outlook writes a smiley as "&#55357;&#56898;", two references
//      to half surrogates that the HTML parser replaces each with U+FFFD.
//      joinSurrogateEntities recomposes them; wired into the display (email-viewer), the
//      reply quote (buildQuote) and the copy (mail-copy).
//   2) Search prefilled with the text selected in the page, selected in the field, with a
//      cross to clear it (mailbox-search.tsx, lib/page-selection.ts).
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/emoji-and-search-selection.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { joinSurrogateEntities } from "../../../packages/common/src/html-entities";
import { buildQuote } from "../../../packages/common/src/compose";
import { normalizeSearchSelection, SEARCH_SELECTION_MAX } from "../lib/page-selection";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("Outlook emoji recomposed", () => {
	assert.equal(
		joinSurrogateEntities('Thanks Jane <span id="&#55357;&#56898;">&#55357;&#56898;</span>'),
		'Thanks Jane <span id="&#128578;">&#128578;</span>',
	);
});
test("pair preceded by another reference", () => {
	assert.equal(joinSurrogateEntities("&#233;&#55357;&#56898;x"), "&#233;&#128578;x");
});
test("hexadecimal references", () => {
	assert.equal(joinSurrogateEntities("&#xD83D;&#xDE42;"), "&#128578;");
});
test("consecutive emoji and named entities", () => {
	assert.equal(
		joinSurrogateEntities("&amp;&#55357;&#56898;&#55357;&#56898;!"),
		"&amp;&#128578;&#128578;!",
	);
});
test("isolated or misordered halves left as is", () => {
	assert.equal(joinSurrogateEntities("a &#55357; b"), "a &#55357; b");
	assert.equal(joinSurrogateEntities("&#56898;&#55357;"), "&#56898;&#55357;");
	assert.equal(joinSurrogateEntities("&#55357;&#55357;&#56898;"), "&#55357;&#128578;");
	assert.equal(joinSurrogateEntities("no entity"), "no entity");
});
test("reply quote: emoji recomposed", () => {
	const q = buildQuote(
		{
			html: "<div>Thanks Jane &#55357;&#56898;</div>",
			text: "Thanks Jane ??",
			fromName: "Bob Roe",
			fromAddress: "bob@example.com",
			dateLabel: "29 Oct 2026",
		} as any,
		{},
	);
	assert.ok(q.body.includes("&#128578;"), q.body);
	assert.ok(!q.body.includes("&#55357;"), q.body);
});
test("display and copy go through joinSurrogateEntities", () => {
	assert.match(src("components/mailbox/default/email-viewer.tsx"), /joinSurrogateEntities\(message\.html\)/);
	assert.match(src("lib/mail-copy.ts"), /parseFromString\(joinSurrogateEntities\(html\)/);
});

test("normalised selection: spaces and line breaks", () => {
	assert.equal(normalizeSearchSelection("  Alpha\n\tand   Beta "), "Alpha and Beta");
	assert.equal(normalizeSearchSelection(""), "");
	assert.equal(normalizeSearchSelection(null), "");
});
test("long selection cut on a word", () => {
	const long = "mot ".repeat(100);
	const out = normalizeSearchSelection(long);
	assert.ok(out.length <= SEARCH_SELECTION_MAX, String(out.length));
	assert.ok(out.endsWith("mot"), out.slice(-10));
});
test("search: selection read on mouse press and keyboard open, cross to clear", () => {
	const s = src("components/mailbox/default/mailbox-search.tsx");
	assert.equal((s.match(/\{\.\.\.triggerProps\}/g) ?? []).length, 2, "both opening buttons");
	assert.match(s, /onMouseDown: \(\) => \{\s*pressedSelection\.current = selectedPageText\(\)/);
	assert.match(s, /else openWithSelection\(\)/, "Ctrl+K");
	assert.match(s, /onFocus=\{\(e\) => e\.currentTarget\.select\(\)\}/, "query selected in the field");
	assert.match(s, /data-k="search-clear"/);
	assert.match(s, /showCloseButton=\{false\}/);
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall tests passed");
