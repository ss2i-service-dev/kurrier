// A click on a notification closes it, unless it hits one of its buttons or links (a deferred
// send keeps its course, hiding the notification does not cancel it).
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/toast-click-dismiss.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toastCloseButtonForClick } from "../lib/toast-click-dismiss";

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

// Minimal tree: each node knows its selectors and its parent; closest walks up.
type Fake = { name: string; matches: string[]; parent: Fake | null; children: Fake[]; closest(sel: string): Fake | null; querySelector(sel: string): Fake | null };
const node = (name: string, matches: string[], parent: Fake | null = null): Fake => {
	const n: Fake = {
		name,
		matches,
		parent,
		children: [],
		closest(sel) {
			const wanted = sel.split(",").map((s) => s.trim());
			for (let c: Fake | null = n; c; c = c.parent) if (c.matches.some((m) => wanted.includes(m))) return c;
			return null;
		},
		querySelector(sel) {
			const wanted = sel.split(",").map((s) => s.trim());
			const walk = (x: Fake): Fake | null => {
				for (const ch of x.children) {
					if (ch.matches.some((m) => wanted.includes(m))) return ch;
					const r = walk(ch);
					if (r) return r;
				}
				return null;
			};
			return walk(n);
		},
	};
	parent?.children.push(n);
	return n;
};

const toast = node("li", ["[data-sonner-toast]"]);
const close = node("close", ["button", "[data-close-button]"], toast);
const content = node("content", ["[data-content]"], toast);
const title = node("title", ["[data-title]"], content);
const action = node("action", ["button", "[data-button]"], toast);
const cancel = node("cancel", ["button", "[data-button]", "[data-cancel]"], toast);
const link = node("a", ["a"], content);
const outside = node("div", ["div"]);

test("click on the text of the notification: its close button is returned", () => {
	assert.equal(toastCloseButtonForClick(title as any)?.name, "close");
	assert.equal(toastCloseButtonForClick(toast as any)?.name, "close");
});

test("click on Send now or Undo: the notification leaves the button to act", () => {
	assert.equal(toastCloseButtonForClick(action as any), null);
	assert.equal(toastCloseButtonForClick(cancel as any), null);
});

test("click on a link in the notification: nothing", () => {
	assert.equal(toastCloseButtonForClick(link as any), null);
});

test("click outside a notification: nothing", () => {
	assert.equal(toastCloseButtonForClick(outside as any), null);
	assert.equal(toastCloseButtonForClick(null), null);
});

test("notification that cannot be dismissed (dismissible: false): nothing", () => {
	const locked = node("li", ["[data-sonner-toast]", '[data-dismissible="false"]']);
	const txt = node("t", ["[data-title]"], locked);
	node("close", ["button", "[data-close-button]"], locked);
	assert.equal(toastCloseButtonForClick(txt as any), null);
});

test("the Toaster is mounted with the close button and the click listener", () => {
	const src = readFileSync(join(__dirname, "../components/ui/sonner.tsx"), "utf8");
	assert.match(src, /closeButton/);
	assert.match(src, /toastCloseButtonForClick/);
});

if (failures) {
	console.log(`\n${failures} failing test(s)`);
	process.exit(1);
}
console.log("\ntoast-click-dismiss: all tests pass");
