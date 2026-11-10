// Onglet reste sur l'ancienne version apres un deploiement (Samuel le 10/11, capture : bulle
// d'evenement de l'agenda avec « An unexpected response was received from the server. »).
// Next ne trouve plus l'action serveur de l'ancien bundle. Regle appli-web-js : numero de
// build visible, route de version en no-store, rechargement force une fois par version.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/app-version.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBuildVersion, onNewVersion } from "../lib/app-version";

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

test("numero de build : date et heure de Paris, puis niveau de patch", () => {
	const d = new Date("2026-11-10T07:42:00Z"); // 08:42 a Paris
	assert.equal(formatBuildVersion(d, "0176"), "20261110.0842-p0176");
	assert.equal(formatBuildVersion(d), "20261110.0842");
	assert.equal(formatBuildVersion(new Date("2026-07-01T22:05:00Z"), ""), "20260702.0005");
});

test("meme version : rien", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "a", reloadedFor: null, composing: false }), "none");
});

test("version servie inconnue (route en panne, serveur qui redemarre) : rien", () => {
	assert.equal(onNewVersion({ loaded: "a", served: null, reloadedFor: null, composing: false }), "none");
	assert.equal(onNewVersion({ loaded: "a", served: "", reloadedFor: null, composing: false }), "none");
});

test("nouvelle version, rien en cours de redaction : rechargement", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: null, composing: false }), "reload");
});

test("nouvelle version pendant la redaction d'un mail : on propose, on ne recharge pas", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: null, composing: true }), "prompt");
});

test("deja recharge pour cette version (boucle evitee) : on propose seulement", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: "b", composing: false }), "prompt");
});

test("la route de version existe, en no-store, et le surveillant est monte a la racine", () => {
	const route = join(__dirname, "../app/api/version/route.ts");
	assert.ok(existsSync(route), "app/api/version/route.ts");
	assert.match(readFileSync(route, "utf8"), /no-store/);
	assert.match(readFileSync(join(__dirname, "../app/layout.tsx"), "utf8"), /<VersionWatcher/);
	assert.match(readFileSync(join(__dirname, "../next.config.ts"), "utf8"), /NEXT_PUBLIC_BUILD_VERSION/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\napp-version : tous les tests passent");
