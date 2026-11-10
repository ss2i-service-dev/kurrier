// Onglet reste sur l'ancienne version apres un deploiement (Samuel le 10/11, capture : bulle
// d'evenement de l'agenda avec « An unexpected response was received from the server. »).
// Next ne trouve plus l'action serveur de l'ancien bundle. Regle appli-web-js : numero de
// build visible, route de version en no-store, rechargement force une fois par version.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/app-version.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBuildVersion, isStaleActionResponse, onNewVersion } from "../lib/app-version";

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
	assert.equal(onNewVersion({ loaded: "a", served: "a", reloadedFor: null }), "none");
});

test("version servie inconnue (route en panne, serveur qui redemarre) : rien", () => {
	assert.equal(onNewVersion({ loaded: "a", served: null, reloadedFor: null }), "none");
	assert.equal(onNewVersion({ loaded: "a", served: "", reloadedFor: null }), "none");
});

// Samuel le 10/11 : « quand il y a besoin de refresh une application et qu'elle n'est pas
// fonctionnelle tant que tu l'as pas refresh, ce que tu fais, c'est que tu forces la personne
// à refresh et tu la laisses pas interagir avec l'application ». Plus de proposition : la page
// est bloquee puis rechargee, redaction en cours ou non (les brouillons ont leur copie locale,
// lib/draft-backup.ts, recuperee au chargement suivant).
test("nouvelle version : rechargement force, meme pendant la redaction", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: null }), "reload");
});

test("deja recharge pour cette version et toujours l'ancien bundle : page bloquee, sans boucle", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: "b" }), "block");
});

test("action serveur inconnue (en-tete x-nextjs-action-not-found) : onglet perime", () => {
	assert.equal(isStaleActionResponse(new Headers({ "x-nextjs-action-not-found": "1" })), true);
	assert.equal(isStaleActionResponse(new Headers({ "content-type": "text/x-component" })), false);
	assert.equal(isStaleActionResponse(null), false);
});

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("plus aucune proposition de recharger : voile bloquant et rechargement", () => {
	const watcher = src("components/common/version-watcher.tsx");
	assert.doesNotMatch(watcher, /contenteditable/);
	assert.match(watcher, /isStaleActionResponse\(/);
	assert.match(watcher, /role="alertdialog"/);
	const notifier = src("components/k/new-mail-notifier.tsx");
	assert.doesNotMatch(notifier, /new version of Kurrier/);
	assert.doesNotMatch(notifier, /Nouvelle version de Kurrier/);
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
