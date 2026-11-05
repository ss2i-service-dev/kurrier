// Deux demandes de Samuel du 05/11/2026. Ce test est lance par Dockerfile.web avant le
// build : rouge = pas d'image.
//   1) Emojis d'Outlook : « Merci Samuel �� » (fil Antellia du 29/10). Outlook ecrit 🙂 en
//      « &#55357;&#56898; », deux references de demi-surrogates que le parseur HTML remplace
//      chacune par U+FFFD. joinSurrogateEntities les recompose ; branche dans l'affichage
//      (email-viewer), la citation de reponse (buildQuote) et la copie (mail-copy).
//   2) Recherche pre-remplie par le texte selectionne dans la page, selectionne dans le
//      champ, avec une croix pour le vider (mailbox-search.tsx, lib/page-selection.ts).
// Lancement (depuis la racine) :
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
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("emoji Outlook du fil Antellia recompose", () => {
	assert.equal(
		joinSurrogateEntities('Merci Samuel <span id="&#55357;&#56898;">&#55357;&#56898;</span>'),
		'Merci Samuel <span id="&#128578;">&#128578;</span>',
	);
});
test("paire precedee d'une autre reference", () => {
	assert.equal(joinSurrogateEntities("&#233;&#55357;&#56898;x"), "&#233;&#128578;x");
});
test("references hexadecimales", () => {
	assert.equal(joinSurrogateEntities("&#xD83D;&#xDE42;"), "&#128578;");
});
test("emojis consecutifs et entites nommees", () => {
	assert.equal(
		joinSurrogateEntities("&amp;&#55357;&#56898;&#55357;&#56898;!"),
		"&amp;&#128578;&#128578;!",
	);
});
test("moities isolees ou dans le mauvais ordre laissees telles quelles", () => {
	assert.equal(joinSurrogateEntities("a &#55357; b"), "a &#55357; b");
	assert.equal(joinSurrogateEntities("&#56898;&#55357;"), "&#56898;&#55357;");
	assert.equal(joinSurrogateEntities("&#55357;&#55357;&#56898;"), "&#55357;&#128578;");
	assert.equal(joinSurrogateEntities("sans entite"), "sans entite");
});
test("citation de reponse : emoji recompose", () => {
	const q = buildQuote(
		{
			html: "<div>Merci Samuel &#55357;&#56898;</div>",
			text: "Merci Samuel ??",
			fromName: "Delphine",
			fromAddress: "d@example.com",
			dateLabel: "29 Oct 2026",
		} as any,
		{},
	);
	assert.ok(q.body.includes("&#128578;"), q.body);
	assert.ok(!q.body.includes("&#55357;"), q.body);
});
test("affichage et copie passent par joinSurrogateEntities", () => {
	assert.match(src("components/mailbox/default/email-viewer.tsx"), /joinSurrogateEntities\(message\.html\)/);
	assert.match(src("lib/mail-copy.ts"), /parseFromString\(joinSurrogateEntities\(html\)/);
});

test("selection normalisee : espaces et retours a la ligne", () => {
	assert.equal(normalizeSearchSelection("  Harmony\n\tet   Elan "), "Harmony et Elan");
	assert.equal(normalizeSearchSelection(""), "");
	assert.equal(normalizeSearchSelection(null), "");
});
test("selection longue coupee sur un mot", () => {
	const long = "mot ".repeat(100);
	const out = normalizeSearchSelection(long);
	assert.ok(out.length <= SEARCH_SELECTION_MAX, String(out.length));
	assert.ok(out.endsWith("mot"), out.slice(-10));
});
test("recherche : selection lue a l'appui souris et a l'ouverture clavier, croix pour vider", () => {
	const s = src("components/mailbox/default/mailbox-search.tsx");
	assert.equal((s.match(/\{\.\.\.triggerProps\}/g) ?? []).length, 2, "les deux boutons d'ouverture");
	assert.match(s, /onMouseDown: \(\) => \{\s*pressedSelection\.current = selectedPageText\(\)/);
	assert.match(s, /else openWithSelection\(\)/, "Ctrl+K");
	assert.match(s, /onFocus=\{\(e\) => e\.currentTarget\.select\(\)\}/, "requete selectionnee dans le champ");
	assert.match(s, /data-ss2i="search-clear"/);
	assert.match(s, /showCloseButton=\{false\}/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
