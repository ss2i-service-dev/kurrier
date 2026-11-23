// Ctrl+A in a mail list ticks every mail of the view, in both interfaces, without ever taking
// Ctrl+A away from an input field or from a mail being written (input lock).
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/select-all-shortcut.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok    ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL  ${name}\n${(e as Error).stack}`);
	}
}

const WEB = join(__dirname, "..");
const code = (p: string) =>
	readFileSync(join(WEB, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("catalog: selectAll entry, Organize group, default Ctrl+a", () => {
	const c = code("components/k/shortcuts-catalog.ts");
	assert.match(c, /\|\s*"selectAll"/, "ShortcutId selectAll");
	assert.match(c, /\{ id: "selectAll", group: "organize", en: "Select all[^}]*defaults: \["Ctrl\+a"\]/);
});

test("script: Ctrl+a in the table, selectAll() action", () => {
	const sh = code("public/keyboard-shortcuts.js");
	assert.match(sh, /\["selectAll", \["Ctrl\+a"\], [^\n]*selectAll\(\)\]/);
});

test("script: the marked box of the visible list, never in an input, a composer, a menu or a dialog", () => {
	const sh = code("public/keyboard-shortcuts.js");
	const m = sh.match(/const selectAll = \(\) => \{([\s\S]*?)\n  \};/);
	assert.ok(m, "selectAll function");
	const f = m![1];
	assert.match(f, /inInput\(document\.activeElement\)/, "native Ctrl+A in a field");
	assert.match(f, /composerOpen\(\)/, "native Ctrl+A while writing");
	assert.match(f, /\[role="menu"\][^\n]*\[role="dialog"\]/, "nothing in a menu or a dialog");
	assert.match(f, /input\[data-k-shortcut="select-all"\]/, "marked box");
	assert.match(f, /\.find\(visible\)/, "visible box only");
	assert.match(f, /!target\.checked/, "already ticked: nothing is unticked");
	assert.match(f, /return true/, "keystroke consumed on a list");
	assert.match(f, /return false/, "otherwise native Ctrl+A");
});

test("both list headers mark their \"select all\" box", () => {
	for (const p of ["components/mailbox/default/mail-list-header.tsx", "components/k/list-header.tsx"]) {
		const c = code(p);
		const i = c.search(/aria-label="Select all"/);
		assert.ok(i > 0, `${p}: box`);
		const around = c.slice(i - 200, i + 300);
		assert.match(around, /data-k-shortcut="select-all"/, `${p}: mark`);
	}
});

if (failed) {
	console.error(`${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nselect-all-shortcut: all tests pass");
