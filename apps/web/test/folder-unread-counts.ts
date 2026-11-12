// Pas de compteur de non lus sur les dossiers de ce qu'on a ecrit soi-meme (Samuel le 10/11,
// capture « Sent (4) » : « ça n'a aucun putain de sens d'afficher le nombre de mails envoyés
// ou en attente d'envoi »). Meme esprit que la corbeille (patch 0046) et l'Archive (0081).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/folder-unread-counts.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_UNREAD_COUNT_KINDS, showsUnreadCount, showsSidebarCount } from "../lib/folder-unread-counts";

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

// Samuel le 12/11 : « ce qui serait intéressant, c'est qu'on ait le nombre de drafts en attente
// d'envoi à côté de drafts ». Drafts affiche son nombre de brouillons (fetchDraftCounts, envois en
// attente exclus), pas des non lus : les autres dossiers de la liste restent sans compteur.
test("Drafts affiche son nombre de brouillons dans la barre latérale", () => {
	assert.equal(showsSidebarCount("drafts"), true);
	for (const k of ["sent", "outbox", "archive", "trash"]) assert.equal(showsSidebarCount(k), false, k);
	for (const k of ["inbox", "spam", "custom"]) assert.equal(showsSidebarCount(k), true, k);
});

test("les barres latérales nourries par fetchDraftCounts appliquent showsSidebarCount", () => {
	for (const p of [
		"components/dashboard/identity-mailboxes-list.tsx",
		"components/k/sidebar-nav.tsx",
	]) assert.match(src(p), /showsSidebarCount\(/, p);
	// l'ancienne barre (mailbox-nav) ne recoit que des non lus : Drafts y reste sans compteur
	assert.match(src("components/mailbox/default/mailbox-nav.tsx"), /showsUnreadCount\(/);
	for (const p of [
		"components/dashboard/workspaces/identity-mailboxes-list-wrapper.tsx",
		"components/k/sidebar-nav-wrapper.tsx",
	]) assert.match(src(p), /fetchDraftCounts\(\)/, p);
});

// Samuel le 12/11 : « sur ma boite perso, ca n'en compte qu'un alors qu'il y en a plein dedans ! ».
// Gmail ne pose pas \Draft sur ses brouillons en IMAP (55 sur 56 en prod n'ont que \Seen) : le
// compteur suit la liste du dossier (un fil par ligne, envois en attente a part), pas le drapeau.
test("fetchDraftCounts compte les fils du dossier Drafts, sans exiger le drapeau draft", () => {
	const s = src("lib/actions/drafts.ts");
	const body = s.slice(s.indexOf("export const fetchDraftCounts"), s.indexOf("export type FetchDraftCountsResult"));
	assert.ok(body.length > 0);
	assert.doesNotMatch(body, /eq\(messages\.draft, true\)/);
	assert.match(body, /count\(distinct \$\{messages\.threadId\}\)/);
	assert.match(body, /pendingSend/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
