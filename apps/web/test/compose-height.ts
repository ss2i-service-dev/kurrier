// Classic interface, new message: the window anchored at the bottom right was h-auto with no
// maximum height. A long text made it grow past the screen: its top (recipients, subject, start
// of the text) went out through the top of the browser window, out of reach.
// The window is now bounded to the screen height, its content scrolls inside, and the send bar
// stays stuck at the bottom of the scrolling area.
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/compose-height.ts
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
const compose = src("components/mailbox/default/compose-mail.tsx");

test("the new message window never exceeds the screen height", () => {
	assert.ok(compose.includes("max-h-[calc(100dvh-2rem)]"), "maximum height bounded to the screen");
	assert.doesNotMatch(compose, /"max-h-none"/, "no more max-h-none on the body");
	assert.match(compose, /fixed z-\[1000\][^"]*flex flex-col/, "window is a flex column");
});
test("the window content scrolls inside", () => {
	assert.match(compose, /compose-scroll min-h-0 overflow-y-auto/, "window body scrolls");
});
test("the send bar stays visible at the bottom of the scrolling area", () => {
	const css = src("app/globals.css");
	assert.match(css, /\.compose-scroll \.mantine-RichTextEditor-root > \.border-t\s*\{[^}]*position: sticky;[^}]*bottom: 0;/, "sticky send bar");
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall checks pass");
