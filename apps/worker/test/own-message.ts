// Message recu dont l'expediteur est une identite du proprietaire (lib/own-message.ts).
// Samuel le 06/11/2026 : « quand je me mets en copie moi-meme, en ecrivant un alias dev, il
// faut detecter que c'est moi qui ai envoye le mail, il ne faut pas mettre le mail non lu,
// parce que c'est moi qui l'ai ecrit, donc je l'ai lu ». Envoye de samuel@ avec dev@ en
// copie, le message revient dans l'Inbox de samuel@ sans drapeau \Seen et restait non lu.
// Aucune base. Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/own-message.ts
import assert from "node:assert/strict";
import { isOwnMessage } from "../lib/own-message";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const identities = ["samuel@ss2i-digital.fr", "Sam.Legros@Gmail.com", "ss2i.ca"];

test("expediteur = identite du proprietaire : message de l'utilisateur", () => {
	assert.equal(isOwnMessage("samuel@ss2i-digital.fr", identities), true);
});

test("comparaison sans casse ni espaces, des deux cotes", () => {
	assert.equal(isOwnMessage("  Samuel@SS2I-Digital.FR ", identities), true);
	assert.equal(isOwnMessage("sam.legros@gmail.com", identities), true);
});

test("une autre identite du meme proprietaire compte aussi", () => {
	assert.equal(isOwnMessage("sam.legros@gmail.com", ["samuel@ss2i-digital.fr", "sam.legros@gmail.com"]), true);
});

test("expediteur externe : pas concerne", () => {
	assert.equal(isOwnMessage("maud@client.fr", identities), false);
});

test("pas de faux positif de sous-chaine ou de domaine", () => {
	assert.equal(isOwnMessage("xsamuel@ss2i-digital.fr", identities), false);
	assert.equal(isOwnMessage("samuel@ss2i-digital.fr.evil.org", identities), false);
	assert.equal(isOwnMessage("autre@ss2i-digital.fr", identities), false);
});

test("identite de domaine (sans @) : n'autorise pas tout le domaine", () => {
	assert.equal(isOwnMessage("quelquun@ss2i.ca", identities), false);
});

test("sans expediteur ou sans identite : pas concerne", () => {
	assert.equal(isOwnMessage(null, identities), false);
	assert.equal(isOwnMessage(undefined, identities), false);
	assert.equal(isOwnMessage("", identities), false);
	assert.equal(isOwnMessage("samuel@ss2i-digital.fr", []), false);
});

if (failures) {
	console.error(`${failures} echec(s)`);
	process.exit(1);
}
