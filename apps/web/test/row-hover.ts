// Nouvelle interface : actions de survol d'une ligne de la liste (libelles, lu/non lu,
// epingler, reporter, archiver, supprimer). Jean-Baptiste le 16/11/2026 : supprimer
// plusieurs fils d'affilee ne marchait qu'une ou deux fois. La ligne cliquee quitte la
// liste, la suivante remonte sous le pointeur immobile, mais ni mouseenter ni :hover
// ne la suivent : pas d'actions montees, et le clic suivant ouvrait le fil.
// La ligne survolee est maintenant deduite de la position du pointeur
// (components/k/row-hover.ts), recalculee quand une ligne est retiree ou deplacee.
// Lance par Dockerfile.web avant le build. Depuis la racine :
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
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("rowIdOf rend le fil de la ligne qui contient l'element", () => {
	const row = { dataset: { threadId: "t42" } };
	const inside = { closest: (sel: string) => (sel === ROW_SELECTOR ? row : null) } as unknown as Element;
	assert.equal(rowIdOf(inside), "t42");
	const outside = { closest: () => null } as unknown as Element;
	assert.equal(rowIdOf(outside), null);
	assert.equal(rowIdOf(null), null);
});

test("la ligne suit la position du pointeur, pas mouseenter", () => {
	const row = src("components/k/thread-row.tsx");
	assert.match(row, /useRowHot\(String\(item\.threadId\)\)/);
	assert.match(row, /data-hot=\{hot \? "true" : undefined\}/);
	assert.match(row, /\(armed \|\| hot\) &&/, "actions montees pour la ligne sous le pointeur");
});

test("une ligne retiree ou une action fait recalculer la ligne survolee", () => {
	const row = src("components/k/thread-row.tsx");
	assert.match(row, /React\.useEffect\(\(\) => \(\) => refreshRowHover\(\), \[\]\)/, "au demontage");
	assert.match(row, /stop\(e\);[\s\S]{0,600}refreshRowHover\(\);/, "au clic sur une action");
	const mod = src("components/k/row-hover.ts");
	assert.match(mod, /elementFromPoint/);
	assert.match(mod, /"pointermove"/);
});

test("le CSS affiche les actions par data-hot, plus par :hover", () => {
	const css = src("app/ss2i-ui.css");
	assert.match(css, /\.k-row\[data-hot="true"\] \.k-row-actions/);
	assert.match(css, /\.k-row\[data-hot="true"\] \.k-row-meta/);
	assert.doesNotMatch(css, /\.k-row:hover \.k-row-(actions|meta)/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nrow-hover : tout est vert");
