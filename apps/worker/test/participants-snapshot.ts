// Participants d'un fil (Samuel le 12/11, liste des fils : « j'ai des mails ils n'ont pas
// d'expéditeur, il y a une case vide sur deux mails »). Les messages envoyes depuis kurrier
// rangent `from` en simple chaine ; le recapitulatif du fil ne lisait que l'objet mailparser.
// Et une ligne de fil sans participants (fusion de fils) ne se reparait jamais : NULL || x = NULL.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/participants-snapshot.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAddressField } from "../../../packages/common/src/address-field";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (e) {
		failures++;
		console.log(`FAIL  ${label}\n      ${(e as Error).message}`);
	}
};

const root = join(__dirname, "..", "..", "..");
const mailSrc = readFileSync(join(root, "packages/common/src/mail.ts"), "utf8");

test("objet mailparser d'un message recu", () => {
	assert.deepEqual(
		parseAddressField({ value: [{ name: "Samuel Legros", address: "samuel@ss2i-digital.fr" }], text: "x" }),
		[{ name: "Samuel Legros", address: "samuel@ss2i-digital.fr" }],
	);
});

test("simple chaine d'un message envoye depuis kurrier", () => {
	assert.deepEqual(parseAddressField("samuel@ss2i-digital.fr"), [
		{ name: null, address: "samuel@ss2i-digital.fr" },
	]);
});

test("chaine avec nom entre guillemets et virgule, plusieurs adresses", () => {
	assert.deepEqual(parseAddressField('"Legros, Samuel" <samuel@ss2i-digital.fr>, dev@ss2i-digital.fr'), [
		{ name: "Legros, Samuel", address: "samuel@ss2i-digital.fr" },
		{ name: null, address: "dev@ss2i-digital.fr" },
	]);
});

test("vide, null, chaine sans adresse", () => {
	assert.deepEqual(parseAddressField(null), []);
	assert.deepEqual(parseAddressField(""), []);
	assert.deepEqual(parseAddressField("undisclosed-recipients:;"), []);
});

test("le recapitulatif du fil lit le champ par parseAddressField", () => {
	assert.match(mailSrc, /parseAddressField\(/);
});

test("l'upsert du fil repare une ligne aux participants NULL", () => {
	assert.match(mailSrc, /coalesce\(\$\{mailboxThreads\.participants\}, '\{\}'::jsonb\) \|\| EXCLUDED\.participants/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
