// Bouton « Pas un spam » dans le message ouvert (Samuel le 10/11 : « Quand on a ouvert un
// message qui est dans la boîte spam, il n'y a pas de bouton pour dire que c'est pas du spam
// et fermer le message et le ramener dans la boîte de réception »).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/not-spam.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inboxIdForSpam } from "../lib/not-spam";

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

const boxes = [
	{ identity: { id: "i1" }, mailboxes: [{ id: "in1", kind: "inbox" }, { id: "sp1", kind: "spam" }, { id: "ar1", kind: "archive" }] },
	{ identity: { id: "i2" }, mailboxes: [{ id: "in2", kind: "inbox" }, { id: "sp2", kind: "spam" }] },
];

test("message ouvert dans le Spam : boîte de réception de la même identité", () => {
	assert.equal(inboxIdForSpam(boxes, "sp1"), "in1");
	assert.equal(inboxIdForSpam(boxes, "sp2"), "in2");
});

test("hors Spam : pas de bouton", () => {
	assert.equal(inboxIdForSpam(boxes, "in1"), null);
	assert.equal(inboxIdForSpam(boxes, "ar1"), null);
	assert.equal(inboxIdForSpam(boxes, "inconnu"), null);
});

test("identité sans boîte de réception ou liste absente : pas de bouton", () => {
	assert.equal(inboxIdForSpam([{ identity: { id: "i3" }, mailboxes: [{ id: "sp3", kind: "spam" }] }], "sp3"), null);
	assert.equal(inboxIdForSpam(null, "sp1"), null);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("interface classique : bouton dans la barre du message, déplacement vers l'Inbox puis retour à la liste", () => {
	const src = read("components/mailbox/default/email-renderer.tsx");
	assert.match(src, /inboxIdForSpam\(/);
	assert.match(src, /moveToFolder\(/);
	assert.match(src, /aria-label="Not spam"/);
});

test("nouvelle interface : bouton dans la barre du fil et action notSpam du store", () => {
	assert.match(read("components/k/thread-toolbar.tsx"), /mailActions\.notSpam\(/);
	assert.match(read("components/k/mail-store.ts"), /notSpam\(/);
	assert.match(read("components/k/thread-page.tsx"), /inboxIdForSpam\(/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nnot-spam : tous les tests passent");
