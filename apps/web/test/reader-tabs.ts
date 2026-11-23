// Three-column interface: opening threads from the list and internal tabs of the reading
// pane. Off by default: a click opens a single thread, as before. The middle click and
// Ctrl/Cmd+click open a browser tab. As an option (Settings > Opening mail), the click or
// the middle click opens an internal tab.
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/reader-tabs.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OPEN_PREFS, resolveRowOpen, sanitizeOpenPrefs } from "../components/k/open-prefs";
import { addTab, MAX_TABS, neighborOf, onThreadShown, removeTabs, type ReaderTab } from "../components/k/reader-tabs";

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
const t = (id: string): ReaderTab => ({ id, url: `/en/w/x/dashboard/mail/i/inbox/threads/${id}`, subject: `S${id}` });
const ids = (tabs: ReaderTab[]) => tabs.map((x) => x.id).join(",");

const left = { button: 0 };
const middle = { button: 1 };
const ctrl = { button: 0, ctrlKey: true };

test("by default: tabs off, a click opens a single thread", () => {
	assert.deepEqual(DEFAULT_OPEN_PREFS, { tabs: false, gesture: "click" });
	assert.deepEqual(sanitizeOpenPrefs(undefined), DEFAULT_OPEN_PREFS);
	assert.deepEqual(sanitizeOpenPrefs({ tabs: "yes", gesture: "x" }), DEFAULT_OPEN_PREFS);
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, left), "single");
});

test("middle click and Ctrl+click: browser tab, even without the option", () => {
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, middle), "browser");
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, ctrl), "browser");
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, { button: 0, metaKey: true }), "browser");
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, { button: 2 }), null);
});

test("option, gesture \"click\": the click opens a tab, the middle click stays with the browser", () => {
	const p = { tabs: true, gesture: "click" as const };
	assert.equal(resolveRowOpen(p, left), "tab");
	assert.equal(resolveRowOpen(p, middle), "browser");
	assert.equal(resolveRowOpen(p, ctrl), "browser");
});

test("option, gesture \"middle\": the middle click opens a tab, the click a single thread", () => {
	const p = { tabs: true, gesture: "middle" as const };
	assert.equal(resolveRowOpen(p, middle), "tab");
	assert.equal(resolveRowOpen(p, left), "single");
	assert.equal(resolveRowOpen(p, ctrl), "browser");
});

test("a tab is added to the right of the displayed tab, without duplicates", () => {
	let tabs = addTab([], t("a"), null);
	tabs = addTab(tabs, t("b"), "a");
	tabs = addTab(tabs, t("c"), "a");
	assert.equal(ids(tabs), "a,c,b");
	assert.equal(ids(addTab(tabs, t("b"), "a")), "a,c,b");
});

test("beyond the maximum, the oldest tab goes", () => {
	let tabs: ReaderTab[] = [];
	for (let i = 0; i < MAX_TABS; i++) tabs = addTab(tabs, t(String(i)), null);
	tabs = addTab(tabs, t("new"), "0");
	assert.equal(tabs.length, MAX_TABS);
	assert.equal(tabs[0].id, "0", "the displayed tab stays");
	assert.ok(!tabs.some((x) => x.id === "1"));
	assert.ok(tabs.some((x) => x.id === "new"));
});

test("thread opened without asking for a tab: it replaces the displayed tab, otherwise nothing", () => {
	const tabs = [t("a"), t("b")];
	assert.equal(ids(onThreadShown(tabs, "a", t("z"))), "z,b");
	assert.equal(ids(onThreadShown(tabs, null, t("z"))), "a,b");
	assert.equal(ids(onThreadShown(tabs, "not-a-tab", t("z"))), "a,b");
	assert.equal(ids(onThreadShown(tabs, "a", t("b"))), "a,b", "tab already open: plain display");
});

test("closing: right neighbour, otherwise left; thread removed from the list", () => {
	const tabs = [t("a"), t("b"), t("c")];
	assert.equal(neighborOf(tabs, "b")?.id, "c");
	assert.equal(neighborOf(tabs, "c")?.id, "b");
	assert.equal(neighborOf([t("a")], "a"), null);
	assert.equal(ids(removeTabs(tabs, ["b"])), "a,c");
	assert.equal(removeTabs(tabs, ["x"]), tabs);
});

test("wiring: row, reading pane, archiving, settings", () => {
	const row = src("components/k/thread-row.tsx");
	assert.match(row, /resolveRowOpen\(getOpenPrefs\(\), e\)/);
	assert.match(row, /onAuxClick=/);
	assert.match(row, /window\.open\(threadUrl, "_blank", "noopener"\)/);
	assert.match(src("components/k/mail-panes.tsx"), /<KReaderTabsBar \/>/);
	assert.match(src("lib/pending-moves.ts"), /closeTabs\(threadIds/);
	assert.match(src("components/k/settings-shell.tsx"), /\$\{base\}\/open/);
	assert.match(src("components/k/ui-context.tsx"), /inApp && modern && <KOpenPrefsConfig \/>/);
	assert.match(src("components/k/reader-tabs-bar.tsx"), /if \(!prefs\.tabs \|\| !tabs\.length\) return null;/);
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nreader-tabs: all green");
