// Pas de compteur de non lus sur les dossiers de ce qu'on a ecrit soi-meme (Samuel le 10/11,
// capture « Sent (4) » : « ça n'a aucun putain de sens d'afficher le nombre de mails envoyés
// ou en attente d'envoi »). Meme esprit que la corbeille (patch 0046) et l'Archive (0081).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/folder-unread-counts.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_UNREAD_COUNT_KINDS, showsUnreadCount } from "../lib/folder-unread-counts";

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

test("Envoyés, Boîte d'envoi, Brouillons, Archive et Corbeille : pas de compteur", () => {
	for (const k of ["sent", "outbox", "drafts", "archive", "trash"]) {
		assert.equal(showsUnreadCount(k), false, k);
		assert.ok(NO_UNREAD_COUNT_KINDS.includes(k as any), k);
	}
});

test("Boîte de réception, Spam et dossiers perso gardent leur compteur", () => {
	for (const k of ["inbox", "spam", "custom"]) assert.equal(showsUnreadCount(k), true, k);
});

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("le serveur ne calcule plus le compteur de ces dossiers (toutes les barres latérales)", () => {
	assert.match(src("lib/actions/mailbox.ts"), /notInArray\(mailboxes\.kind, \[\.\.\.NO_UNREAD_COUNT_KINDS\]\)/);
});

test("les trois barres latérales appliquent la même règle", () => {
	for (const p of [
		"components/dashboard/identity-mailboxes-list.tsx",
		"components/k/sidebar-nav.tsx",
		"components/mailbox/default/mailbox-nav.tsx",
	]) assert.match(src(p), /showsUnreadCount\(/, p);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
