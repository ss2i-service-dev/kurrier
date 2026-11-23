// Three-column interface: hover actions of a list row (labels, read/unread, pin, snooze,
// archive, delete). Deleting several threads in a row only worked once or twice. The clicked row
// leaves the list, the next one moves up under the motionless pointer, but neither mouseenter
// nor :hover follow it: no actions mounted, and the next click opened the thread.
// The hovered row is now deduced from the pointer position (components/k/row-hover.ts),
// recomputed when a row is removed or moved.
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/row-hover.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROW_SELECTOR, rowIdOf } from "../components/k/row-hover";

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

test("rowIdOf returns the thread of the row containing the element", () => {
	const row = { dataset: { threadId: "t42" } };
	const inside = { closest: (sel: string) => (sel === ROW_SELECTOR ? row : null) } as unknown as Element;
	assert.equal(rowIdOf(inside), "t42");
	const outside = { closest: () => null } as unknown as Element;
	assert.equal(rowIdOf(outside), null);
	assert.equal(rowIdOf(null), null);
});

test("the row follows the pointer position, not mouseenter", () => {
	const row = src("components/k/thread-row.tsx");
	assert.match(row, /useRowHot\(String\(item\.threadId\)\)/);
	assert.match(row, /data-hot=\{hot \? "true" : undefined\}/);
	assert.match(row, /\(armed \|\| hot\) &&/, "actions mounted for the row under the pointer");
});

test("a removed row or an action recomputes the hovered row", () => {
	const row = src("components/k/thread-row.tsx");
	assert.match(row, /React\.useEffect\(\(\) => \(\) => refreshRowHover\(\), \[\]\)/, "on unmount");
	assert.match(row, /stop\(e\);[\s\S]{0,600}refreshRowHover\(\);/, "on click on an action");
	const mod = src("components/k/row-hover.ts");
	assert.match(mod, /elementFromPoint/);
	assert.match(mod, /"pointermove"/);
});

test("the CSS shows the actions through data-hot, no longer through :hover", () => {
	const css = src("app/k-ui.css");
	assert.match(css, /\.k-row\[data-hot="true"\] \.k-row-actions/);
	assert.match(css, /\.k-row\[data-hot="true"\] \.k-row-meta/);
	assert.doesNotMatch(css, /\.k-row:hover \.k-row-(actions|meta)/);
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nrow-hover: all green");
