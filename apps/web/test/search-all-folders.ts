// Recherche etendue a tous les dossiers. Samuel le 06/11/2026 : « je veux bien que depuis la
// boite de reception, quand on recherche, ca cherche que dans la boite de reception, mais si
// on trouve rien, a ce moment-la, tu proposes etendre la recherche dans la modale ».
// Cas reel : « Franck Moioli, AXA » cherche depuis l'Inbox, 6 fils tous en Archive ou Sent.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/search-all-folders.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchFilters, SEARCH_EXCLUDED_KINDS } from "../lib/search-scope";

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

const base = { workspacePublicId: "w1", identityPublicId: "i1" };

test("dossier courant : filtre sur son slug, comme avant", () => {
	const f = searchFilters({ ...base, mailboxSlug: "inbox" });
	assert.deepEqual(f, ['workspacePublicId:="w1"', 'identityPublicId:="i1"', 'mailboxSlug:="inbox"']);
});
test("tous les dossiers : plus de filtre sur le dossier, Corbeille et Spam exclus", () => {
	const f = searchFilters({ ...base, mailboxSlug: null, excludeSlugs: ["trash", "spam"] });
	assert.ok(f);
	assert.ok(!f.some((x) => x.startsWith("mailboxSlug:=")), "filtre sur un dossier en mode etendu");
	assert.ok(f.includes("mailboxSlug:!=[`trash`,`spam`]"), f.join(" && "));
});
test("tous les dossiers sans dossier a exclure : aucun filtre de dossier", () => {
	const f = searchFilters({ ...base, mailboxSlug: null, excludeSlugs: [] });
	assert.ok(f && !f.some((x) => x.startsWith("mailboxSlug")));
});
test("options cumulees", () => {
	const f = searchFilters({ ...base, mailboxSlug: "inbox", hasAttachment: true, onlyUnread: true, starred: true });
	assert.ok(f && f.includes("hasAttachment:=1") && f.includes("unread:=1") && f.includes("starred:=1"));
});
test("slug capable de sortir du filtre Typesense : refuse", () => {
	assert.equal(searchFilters({ ...base, mailboxSlug: 'x" || a:=1' }), null);
	assert.equal(searchFilters({ ...base, mailboxSlug: null, excludeSlugs: ["a`,`b"] }), null);
});
test("Corbeille, Spam et Outbox restent hors de la recherche etendue", () => {
	for (const k of ["trash", "spam", "outbox"]) assert.ok(SEARCH_EXCLUDED_KINDS.includes(k), k);
});

const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const action = strip(readFileSync(join(__dirname, "../lib/actions/mailbox.ts"), "utf8"));
test("initSearch accepte la recherche etendue et renvoie le dossier de chaque resultat", () => {
	const start = action.indexOf("export const initSearch");
	const body = action.slice(start, action.indexOf("export const", start + 10));
	assert.ok(/allFolders/.test(body), "initSearch ne connait pas allFolders");
	assert.ok(/searchFilters\(/.test(body), "initSearch ne passe pas par searchFilters");
	assert.ok(/mailboxSlug:\s*d\.mailboxSlug/.test(body), "le dossier du resultat n'est pas renvoye");
});

const modal = strip(readFileSync(join(__dirname, "../components/mailbox/default/mailbox-search.tsx"), "utf8"));
test("la modale propose d'etendre la recherche quand le dossier ne donne rien", () => {
	assert.ok(/data-ss2i="search-all-folders"/.test(modal), "bouton d'extension absent");
	assert.ok(/setAllFolders\(true\)/.test(modal), "le bouton n'etend pas la recherche");
	assert.ok(/allFolders,?\s*\)/.test(modal) || /,\s*allFolders\s*\)/.test(modal), "allFolders non transmis a initSearch");
});
test("en mode etendu, chaque resultat s'ouvre dans son propre dossier", () => {
	assert.ok(/t\.mailboxSlug/.test(modal), "lien du resultat construit sur le dossier courant");
});
test("chaque nouvelle ouverture de la modale repart du dossier courant", () => {
	assert.ok(/setAllFolders\(false\)/.test(modal), "le mode etendu n'est jamais remis a zero");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
