// ss2i : zoom de la grille de l'agenda et heures de travail (Samuel le 24/11/2026 : « pouvoir
// noter une heure d'embauche et de debauche pour avoir des heures de travail habituelles, et
// aussi pouvoir zoomer sur la finesse horaire, car la on a des blocs d'une heure a une demi-heure
// au plus fin visuellement »).
// Depuis la racine : node_modules/.bin/tsx apps/web/test/agenda-zoom.ts
import assert from "node:assert/strict";
import {
	DEFAULT_HOUR_HEIGHT,
	ZOOM_LEVELS,
	anchoredScrollTop,
	gridLineStep,
	labelStep,
	nearestZoom,
	parseHourInput,
	validWorkHours,
	wheelZoomStep,
	zoomStep,
} from "../lib/agenda-zoom";

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

test("le niveau par defaut est l'ancienne hauteur (44 px l'heure)", () => {
	assert.equal(DEFAULT_HOUR_HEIGHT, 44);
	assert.ok(ZOOM_LEVELS.includes(DEFAULT_HOUR_HEIGHT));
});

test("zoom avant et arriere par crans, borne aux extremes", () => {
	assert.ok(zoomStep(44, 1) > 44);
	assert.ok(zoomStep(44, -1) < 44);
	const max = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
	assert.equal(zoomStep(max, 1), max);
	assert.equal(zoomStep(ZOOM_LEVELS[0], -1), ZOOM_LEVELS[0]);
});

test("une valeur memorisee hors des crans revient au cran le plus proche", () => {
	assert.equal(nearestZoom(45), 44);
	assert.equal(nearestZoom(Number.NaN), DEFAULT_HOUR_HEIGHT);
	assert.equal(nearestZoom(10_000), ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
});

test("au plus fin on voit les quarts d'heure (lignes et heures ecrites)", () => {
	const max = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
	assert.equal(gridLineStep(max), 15);
	assert.equal(labelStep(max), 15);
	// Par defaut : rien ne change (demi-heure en pointilles, heures pleines ecrites).
	assert.equal(gridLineStep(44), 30);
	assert.equal(labelStep(44), 60);
	// Les libelles ne se chevauchent jamais (au moins 16 px entre deux).
	for (const h of ZOOM_LEVELS) assert.ok((labelStep(h) / 60) * h >= 16, `libelles serres a ${h}`);
});

test("saisie d'une heure : HH:MM, 8h30, 830, 8, en 24 h", () => {
	assert.equal(parseHourInput("08:30"), 8 * 60 + 30);
	assert.equal(parseHourInput("8h30"), 8 * 60 + 30);
	assert.equal(parseHourInput("8h"), 8 * 60);
	assert.equal(parseHourInput("830"), 8 * 60 + 30);
	assert.equal(parseHourInput("17"), 17 * 60);
	assert.equal(parseHourInput(" 17:45 "), 17 * 60 + 45);
	assert.equal(parseHourInput("24:00"), 24 * 60);
	assert.equal(parseHourInput("25:00"), null);
	assert.equal(parseHourInput("8:75"), null);
	assert.equal(parseHourInput("5 PM"), null);
	assert.equal(parseHourInput(""), null);
});

test("la debauche doit suivre l'embauche", () => {
	assert.equal(validWorkHours(8 * 60, 18 * 60), true);
	assert.equal(validWorkHours(18 * 60, 8 * 60), false);
	assert.equal(validWorkHours(8 * 60, 8 * 60), false);
	assert.equal(validWorkHours(-1, 8 * 60), false);
	assert.equal(validWorkHours(8 * 60, 24 * 60 + 1), false);
});

test("le zoom garde sous le pointeur l'heure qui y etait", () => {
	// 10 h sous le pointeur, a 200 px du haut de la zone defilante.
	const oldH = 44;
	const top = 10 * oldH - 200;
	const next = anchoredScrollTop(oldH, 96, top, 200);
	assert.equal(next + 200, 10 * 96);
	assert.equal(anchoredScrollTop(96, 44, 0, 0), 0);
	assert.ok(anchoredScrollTop(44, 32, 10, 300) >= 0);
});

test("Ctrl+molette : un cran par geste franc, le pave tactile cumule ses petits pas", () => {
	assert.deepEqual(wheelZoomStep(0, -100), { acc: 0, step: 1 });
	assert.deepEqual(wheelZoomStep(0, 100), { acc: 0, step: -1 });
	let acc = 0;
	let steps = 0;
	for (let i = 0; i < 10; i++) {
		const r = wheelZoomStep(acc, -8);
		acc = r.acc;
		steps += r.step;
	}
	assert.equal(steps, 1);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout passe");
