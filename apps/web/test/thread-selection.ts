// Range selection of threads (Shift+click) in the mail lists, classic and modern
// interfaces. This test is run by Dockerfile.web before the build: red = no image.
//   1) range logic (lib/thread-selection.ts);
//   2) wiring: every list that renders a thread row (WebmailListItem, KThreadRow) passes it
//      orderedThreadIds, otherwise Shift+click only checks one row (search, label views);
//   3) Shift+click does not highlight the text of the rows: each thread row blocks native
//      text selection on a mouse press with Shift (preventShiftTextSelection).
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/thread-selection.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { preventShiftTextSelection, toggleThreadSelection } from "../lib/thread-selection";

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

const ids = ["a", "b", "c", "d", "e", "f"];
const sel = (s: { selectedThreadIds: Set<string> }) => [...s.selectedThreadIds].sort();

test("plain click: checks a single row and sets the anchor", () => {
	const s = toggleThreadSelection(undefined, "b", false, ids);
	assert.deepEqual(sel(s), ["b"]);
	assert.equal(s.lastSelectedThreadId, "b");
});

test("Shift+click further down: checks the whole range from the anchor", () => {
	let s = toggleThreadSelection(undefined, "b", false, ids);
	s = toggleThreadSelection(s, "e", true, ids);
	assert.deepEqual(sel(s), ["b", "c", "d", "e"]);
	assert.equal(s.lastSelectedThreadId, "e");
});

test("Shift+click further up: range in the other direction", () => {
	let s = toggleThreadSelection(undefined, "e", false, ids);
	s = toggleThreadSelection(s, "b", true, ids);
	assert.deepEqual(sel(s), ["b", "c", "d", "e"]);
});

test("Shift+click on a checked box: unchecks the range, keeps the rest", () => {
	let s = toggleThreadSelection(undefined, "a", false, ids);
	s = toggleThreadSelection(s, "f", true, ids);
	s = toggleThreadSelection(s, "b", false, ids); // unchecks b, anchor b
	s = toggleThreadSelection(s, "d", true, ids); // d checked -> unchecks b..d
	assert.deepEqual(sel(s), ["a", "e", "f"]);
});

test("Shift+click without an anchor: a single row", () => {
	const s = toggleThreadSelection(undefined, "c", true, ids);
	assert.deepEqual(sel(s), ["c"]);
});

test("anchor gone from the list: a single row", () => {
	let s = toggleThreadSelection(undefined, "zz", false, ["zz", ...ids]);
	s = toggleThreadSelection(s, "d", true, ids);
	assert.deepEqual(sel(s), ["d", "zz"]);
});

test("the other keys of the context are kept", () => {
	const prev = { selectedThreadIds: new Set<string>(), lastSelectedThreadId: undefined, activeMailbox: "inbox" };
	const s = toggleThreadSelection(prev, "a", false, ids);
	assert.equal((s as any).activeMailbox, "inbox");
	assert.equal(prev.selectedThreadIds.size, 0, "the previous state is not modified");
});

test("same thread in two mailboxes (search): correct range", () => {
	const dup = ["a", "b", "a", "c", "d"];
	let s = toggleThreadSelection(undefined, "b", false, dup);
	s = toggleThreadSelection(s, "d", true, dup);
	assert.deepEqual(sel(s), ["a", "b", "c", "d"]);
});

test("mouse press with Shift: native text selection blocked", () => {
	let prevented = 0;
	preventShiftTextSelection({ shiftKey: true, preventDefault: () => prevented++ });
	assert.equal(prevented, 1);
});

test("mouse press without Shift: nothing is blocked (selectable text, drag possible)", () => {
	let prevented = 0;
	preventShiftTextSelection({ shiftKey: false, preventDefault: () => prevented++ });
	assert.equal(prevented, 0);
});

// Each row component wires preventShiftTextSelection on its <li>.
for (const rel of ["components/mailbox/default/webmail-list-item.tsx", "components/k/thread-row.tsx"]) {
	test(`row ${rel} does not highlight text on Shift+click`, () => {
		const src = readFileSync(join(__dirname, "..", rel), "utf8");
		const li = src.indexOf("<li");
		assert.ok(li >= 0, "no <li> in the component");
		assert.match(src.slice(li, li + 600), /onMouseDown=\{preventShiftTextSelection\}/, "onMouseDown={preventShiftTextSelection} missing from the <li>");
	});
}

// Wiring: every <WebmailListItem ...> and <KThreadRow ...> receives orderedThreadIds.
const webRoot = join(__dirname, "..");
const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		if (name === "node_modules" || name === ".next" || name === "test") return [];
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
	});
const ROWS = ["WebmailListItem", "KThreadRow"];
const usages: { file: string; tag: string; ok: boolean }[] = [];
for (const file of [...walk(join(webRoot, "components")), ...walk(join(webRoot, "app"))]) {
	const src = readFileSync(file, "utf8");
	for (const tag of ROWS) {
		const re = new RegExp(`<${tag}(?![\\w-])`, "g");
		let m: RegExpExecArray | null;
		while ((m = re.exec(src))) {
			const end = src.indexOf("/>", m.index);
			const props = src.slice(m.index, end === -1 ? undefined : end);
			usages.push({ file: relative(webRoot, file), tag, ok: /\borderedThreadIds\s*=/.test(props) });
		}
	}
}

test("at least one list of each interface is found", () => {
	for (const tag of ROWS) assert.ok(usages.some((u) => u.tag === tag), `no <${tag}> found`);
});

for (const u of usages) {
	test(`<${u.tag}> receives orderedThreadIds in ${u.file}`, () => {
		assert.ok(u.ok, "Shift+click only checks one row in this list");
	});
}

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall tests passed");
