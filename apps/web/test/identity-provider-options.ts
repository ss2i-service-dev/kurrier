// Formulaire « Ajouter une adresse e-mail » : un compte SMTP deja utilise par une identite
// n'est plus propose (repris de 8189d986 amont, #651). Avant : le meme compte restait dans
// la liste et un second ajout creait une identite en double sur la meme adresse.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/identity-provider-options.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { availableProviderOptions } from "../lib/identity-provider-options";

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

const smtp = (id: number, username: string) => ({ linkRow: { id }, username });
const usernameOf = (a: { username: string }) => a.username;
const options = [
	{ label: "SES", value: "provider-7" },
	{ label: "SMTP a", value: "smtp-1" },
	{ label: "SMTP b", value: "smtp-2" },
	{ label: "SMTP c", value: "smtp-3" },
	{ label: "SMTP d", value: "smtp-4" },
	{ label: "SMTP inconnu", value: "smtp-99" },
];
const accounts = [
	smtp(1, "a@ss2i.ca"),
	smtp(2, "B@ss2i.ca"),
	smtp(3, "a@ss2i.ca"),
	smtp(4, "  "),
];
const values = (opts: { value: string }[]) => opts.map((o) => o.value);

test("un compte SMTP deja utilise par une identite disparait (casse ignoree)", () => {
	assert.deepEqual(values(availableProviderOptions(options, accounts, ["b@SS2I.ca"], usernameOf)), ["provider-7", "smtp-1"]);
});
test("deux comptes SMTP sur la meme adresse : un seul propose", () => {
	assert.deepEqual(values(availableProviderOptions(options, accounts, [], usernameOf)), ["provider-7", "smtp-1", "smtp-2"]);
});
test("compte SMTP sans adresse ou introuvable ecarte, fournisseur conserve", () => {
	const out = values(availableProviderOptions(options, accounts, ["a@ss2i.ca", "b@ss2i.ca"], usernameOf));
	assert.deepEqual(out, ["provider-7"]);
});

const form = readFileSync(join(__dirname, "../components/dashboard/identities/add-email-identity-form.tsx"), "utf8");
test("le formulaire passe par availableProviderOptions", () => {
	assert.ok(/availableProviderOptions\(/.test(form), "availableProviderOptions non appelee");
	assert.ok(/options: providerChoices,/.test(form), "le select doit recevoir la liste filtree, pas providerOptions");
	assert.ok(!/options: providerOptions,/.test(form), "providerOptions brut encore passe au select");
});

if (failures) {
	console.log(`${failures} echec(s)`);
	process.exit(1);
}
