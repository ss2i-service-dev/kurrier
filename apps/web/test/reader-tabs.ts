// Nouvelle interface : ouverture des fils depuis la liste et onglets internes du
// volet lecture (Jean-Baptiste le 18/11/2026). Desactive par defaut : un clic
// ouvre un seul fil, comme avant. Le clic molette et Ctrl/Cmd+clic ouvrent un
// onglet du navigateur. En option (Parametres > Ouverture des mails), le clic ou
// le clic molette ouvre un onglet interne.
// Lance par Dockerfile.web avant le build. Depuis la racine :
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
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const t = (id: string): ReaderTab => ({ id, url: `/en/w/x/dashboard/mail/i/inbox/threads/${id}`, subject: `S${id}` });
const ids = (tabs: ReaderTab[]) => tabs.map((x) => x.id).join(",");

const left = { button: 0 };
const middle = { button: 1 };
const ctrl = { button: 0, ctrlKey: true };

test("par defaut : onglets desactives, le clic ouvre un seul fil", () => {
	assert.deepEqual(DEFAULT_OPEN_PREFS, { tabs: false, gesture: "click" });
	assert.deepEqual(sanitizeOpenPrefs(undefined), DEFAULT_OPEN_PREFS);
	assert.deepEqual(sanitizeOpenPrefs({ tabs: "oui", gesture: "x" }), DEFAULT_OPEN_PREFS);
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, left), "single");
});

test("clic molette et Ctrl+clic : onglet du navigateur, meme sans l'option", () => {
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, middle), "browser");
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, ctrl), "browser");
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, { button: 0, metaKey: true }), "browser");
	assert.equal(resolveRowOpen(DEFAULT_OPEN_PREFS, { button: 2 }), null);
});

test("option, geste « clic » : le clic ouvre un onglet, la molette reste au navigateur", () => {
	const p = { tabs: true, gesture: "click" as const };
	assert.equal(resolveRowOpen(p, left), "tab");
	assert.equal(resolveRowOpen(p, middle), "browser");
	assert.equal(resolveRowOpen(p, ctrl), "browser");
});

test("option, geste « clic molette » : la molette ouvre un onglet, le clic un seul fil", () => {
	const p = { tabs: true, gesture: "middle" as const };
	assert.equal(resolveRowOpen(p, middle), "tab");
	assert.equal(resolveRowOpen(p, left), "single");
	assert.equal(resolveRowOpen(p, ctrl), "browser");
});

test("un onglet s'ajoute a droite de l'onglet affiche, sans doublon", () => {
	let tabs = addTab([], t("a"), null);
	tabs = addTab(tabs, t("b"), "a");
	tabs = addTab(tabs, t("c"), "a");
	assert.equal(ids(tabs), "a,c,b");
	assert.equal(ids(addTab(tabs, t("b"), "a")), "a,c,b");
});

test("au-dela du maximum, l'onglet le plus ancien part", () => {
	let tabs: ReaderTab[] = [];
	for (let i = 0; i < MAX_TABS; i++) tabs = addTab(tabs, t(String(i)), null);
	tabs = addTab(tabs, t("new"), "0");
	assert.equal(tabs.length, MAX_TABS);
	assert.equal(tabs[0].id, "0", "l'onglet affiche reste");
	assert.ok(!tabs.some((x) => x.id === "1"));
	assert.ok(tabs.some((x) => x.id === "new"));
});

test("fil ouvert sans demande d'onglet : il remplace l'onglet affiche, sinon rien", () => {
	const tabs = [t("a"), t("b")];
	assert.equal(ids(onThreadShown(tabs, "a", t("z"))), "z,b");
	assert.equal(ids(onThreadShown(tabs, null, t("z"))), "a,b");
	assert.equal(ids(onThreadShown(tabs, "hors-onglets", t("z"))), "a,b");
	assert.equal(ids(onThreadShown(tabs, "a", t("b"))), "a,b", "onglet deja ouvert : simple affichage");
});

test("fermeture : voisin de droite, sinon de gauche ; fil retire de la liste", () => {
	const tabs = [t("a"), t("b"), t("c")];
	assert.equal(neighborOf(tabs, "b")?.id, "c");
	assert.equal(neighborOf(tabs, "c")?.id, "b");
	assert.equal(neighborOf([t("a")], "a"), null);
	assert.equal(ids(removeTabs(tabs, ["b"])), "a,c");
	assert.equal(removeTabs(tabs, ["x"]), tabs);
});

test("branchements : ligne, volet lecture, archivage, parametres", () => {
	const row = src("components/k/thread-row.tsx");
	assert.match(row, /resolveRowOpen\(getOpenPrefs\(\), e\)/);
	assert.match(row, /onAuxClick=/);
	assert.match(row, /window\.open\(threadUrl, "_blank", "noopener"\)/);
	assert.match(src("components/k/mail-panes.tsx"), /<KReaderTabsBar \/>/);
	assert.match(src("lib/pending-moves.ts"), /closeTabs\(threadIds/);
	assert.match(src("components/k/settings-shell.tsx"), /\$\{base\}\/open/);
	assert.match(src("components/k/reader-tabs-bar.tsx"), /if \(!prefs\.tabs \|\| !tabs\.length\) return null;/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nreader-tabs : tout est vert");
