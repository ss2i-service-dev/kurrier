// Editeur de transfert et de reponse, interface classique. Samuel le 06/11/2026 :
// « Quand je suis dans la zone du texte forwarde et que je supprime, ça me met dans la zone
// de saisie de destinataire » ; « quand je forward un mail, on a une enorme zone vide ».
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
//   1) logique (lib/ready-once.ts) : onReady (defilement + focus) ne part qu'une fois, meme
//      si le parent repasse une nouvelle fonction a chaque rendu ;
//   2) cablage : EmailEditor ne rejoue plus onReady dans un effet qui depend de onReady ;
//      le corps ne reserve 384 px (min-h-96) que sans message cite ou transfere.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/compose-focus.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReadyGate } from "../lib/ready-once";

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

test("onReady une seule fois malgre une nouvelle fonction a chaque rendu", () => {
	const gate = createReadyGate<string>();
	const calls: string[] = [];
	// Rendu 1 : element pas encore monte, rien.
	assert.equal(gate.fire(null, (el) => calls.push(`r1:${el}`)), false);
	// Rendu 2 : element monte, premier appel.
	assert.equal(gate.fire("editor", (el) => calls.push(`r2:${el}`)), true);
	// Rendus suivants (autosave du brouillon, saisie dans le message transfere) : plus rien,
	// sinon le focus repart sur « A ».
	for (let i = 3; i < 10; i++) assert.equal(gate.fire("editor", (el) => calls.push(`r${i}:${el}`)), false);
	assert.deepEqual(calls, ["r2:editor"]);
});

test("sans onReady, la porte se ferme quand meme", () => {
	const gate = createReadyGate<string>();
	assert.equal(gate.fire("editor", undefined), true);
	assert.equal(gate.fire("editor", () => assert.fail("rejoue")), false);
});

test("EmailEditor : pas d'effet dependant de onReady, porte createReadyGate", () => {
	const s = src("components/mailbox/default/editor/email-editor.tsx");
	assert.doesNotMatch(s, /\[\s*onReady\s*\]/, "un effet sur [onReady] se rejoue a chaque rendu du parent");
	assert.match(s, /createReadyGate/, "EmailEditor doit passer par createReadyGate");
});

test("corps de l'editeur classique : min-h-96 seulement sans citation", () => {
	const s = src("components/mailbox/default/editor/rich-text-editor.tsx");
	assert.doesNotMatch(s, /"prose min-h-96/, "min-h-96 fixe : grande zone vide au-dessus du message transfere");
	assert.match(s, /hasQuote && state\.message \? "min-h-28" : "min-h-96"/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
