// Gestes tactiles de l'agenda. Samuel le 19/11/2026 : « si j'essaye de scroller dans ma
// journee, ca m'ouvre la pop-up de nouvel evenement ». La colonne du jour appelait onSlot
// des le pointerdown d'un doigt, donc au debut de tout defilement. Un appui au doigt ne
// doit plus rien faire : la creation attend le click, que le navigateur n'emet pas quand
// le geste devient un defilement. Meme defaut dans la frise de l'assistant de planification.
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/touch-gestures.ts
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
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

/** Corps du gestionnaire `prop={...}` qui suit `anchor` dans `src`, accolades equilibrees. */
function handlerAfter(src: string, anchor: string, prop: string): string {
	const at = src.indexOf(anchor);
	assert.ok(at >= 0, `ancre introuvable : ${anchor}`);
	const start = src.indexOf(`${prop}={`, at);
	assert.ok(start >= 0, `${prop} introuvable apres ${anchor}`);
	let depth = 0;
	for (let i = start + prop.length + 1; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
	}
	throw new Error(`${prop} non ferme`);
}

test("colonne du jour : un doigt ne cree rien a l'appui, la creation passe par le click", () => {
	const src = read("components/outlook-calendar/calendar-grid.tsx");
	const down = handlerAfter(src, "columns.current.set(d, el)", "onPointerDown");
	// Pour un pointeur autre que la souris, on sort avant tout appel a onSlot.
	const touchBranch = down.match(/if \(ev\.pointerType !== "mouse"\) \{([\s\S]*?)\}/);
	assert.ok(touchBranch, "pas de branche dediee au doigt dans onPointerDown");
	assert.doesNotMatch(touchBranch![1], /onSlot\(/, "onSlot appele des l'appui du doigt");
	assert.match(touchBranch![1], /return;/);
	const click = handlerAfter(src, "columns.current.set(d, el)", "onClick");
	assert.match(click, /onSlot\(/, "aucun onClick ne cree l'evenement apres un appui au doigt");
});

test("assistant de planification : un doigt hors du cadre ne deplace pas le creneau a l'appui", () => {
	const src = read("components/outlook-calendar/scheduling-assistant.tsx");
	const down = src.slice(src.indexOf("const down = "), src.indexOf("const move = "));
	const touch = down.indexOf('ev.pointerType !== "mouse"');
	assert.ok(touch >= 0, "pas de branche dediee au doigt dans down");
	assert.ok(touch < down.indexOf("apply("), "le creneau saute avant le test du doigt");
	assert.ok(touch < down.indexOf("preventDefault"), "preventDefault avant le test du doigt");
	assert.match(src, /onClick=\{tap\}/, "aucun click ne fait sauter le creneau apres un appui au doigt");
	assert.match(src, /data-handle="move"[\s\S]{0,200}touch-none/, "le cadre deplacable au doigt doit couper le defilement natif");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
