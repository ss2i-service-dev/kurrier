// Detail d'un evenement de l'agenda en vraie fenetre (Samuel le 10/11 : « si on clique a cote
// [...] ca veut dire qu'on veut la fermer, et pas interagir avec le reste du calendrier » et
// « elle est toute petite par rapport au reste du calendrier [...] une mini-modale »).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/event-modal.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventModalBox } from "../lib/event-modal";

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

test("grand ecran : fenetre centree d'une bonne part de l'ecran", () => {
	const b = eventModalBox(1920, 1080);
	assert.ok(b.width >= 900, `largeur ${b.width}`);
	assert.ok(b.height >= 0.7 * 1080, `hauteur ${b.height}`);
	assert.equal(b.left, (1920 - b.width) / 2);
	assert.equal(b.top, (1080 - b.height) / 2);
});

test("portable : au moins la moitie de la largeur, marges gardees", () => {
	const b = eventModalBox(1366, 768);
	assert.ok(b.width >= 1366 / 2, `largeur ${b.width}`);
	assert.ok(b.left >= 16 && b.top >= 16);
});

test("petit ecran : jamais plus grand que la fenetre", () => {
	const b = eventModalBox(600, 500);
	assert.ok(b.width <= 600 - 32 && b.height <= 500 - 32);
	assert.ok(b.left >= 16 && b.top >= 16);
});

test("un fond couvre le calendrier : le clic a cote ferme sans atteindre la grille", () => {
	const src = readFileSync(join(__dirname, "../components/outlook-calendar/event-popover.tsx"), "utf8");
	assert.match(src, /data-event-backdrop/);
	assert.doesNotMatch(src, /addEventListener\("mousedown"/, "plus de fermeture par ecoute du document : le clic passait a la grille");
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nevent-modal : tous les tests passent");
