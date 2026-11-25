// Nettoyage automatique depuis une recherche (MT11 de docs/plans/nettoyage-auto-recherche.md) : bouton
// « Nettoyage auto... » dans la recherche de l'interface classique, qui ouvre KCleanupRule (dans une
// Modal Mantine) avec la recherche telle qu'a l'ecran. Une regle envoie des fils a la Corbeille de facon
// permanente : bouton reserve au proprietaire de l'identite, desactive (avec la raison affichee) quand le
// filtre « favoris » est actif ou que le dossier courant n'est pas nettoyable hors « tous les dossiers »,
// et jamais d'etoile transmise. Test de cablage sur les sources. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/cleanup-search-classic.ts
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}\n${(e as Error).stack}`);
	}
}

const ROOT = join(__dirname, "..", "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => (existsSync(join(ROOT, p)) ? strip(readFileSync(join(ROOT, p), "utf8")) : "");

const SEARCH = "apps/web/components/mailbox/default/mailbox-search.tsx";
const HEADER = "apps/web/components/mailbox/mailbox-search-header.tsx";
const CHANGELOGS = join(ROOT, "apps/web/changelogs");

const search = read(SEARCH);
const header = read(HEADER);

test("la recherche ouvre KCleanupRule dans une Modal Mantine", () => {
	assert.match(search, /import KCleanupRule from "@\/components\/k\/cleanup-rule-form"/);
	assert.match(search, /from "@mantine\/core"/);
	assert.match(search, /<Modal\b/);
	assert.match(search, /<KCleanupRule\b/);
	// onDone ferme la Modal.
	assert.match(search, /onDone=\{[^}]*setCleanupOpen\(false\)/);
});

test("bouton Nettoyage auto... : requete non vide et proprietaire seulement", () => {
	assert.match(search, /Nettoyage auto\.\.\./);
	assert.match(search, /data-ss2i="search-cleanup"/);
	// Le serveur ne passe `cleanup` qu'au proprietaire de l'identite : sans lui, aucun bouton.
	// La requete vide masque le bouton par cleanupButtonState (show: false).
	assert.match(search, /cleanup\s*&&\s*cleanupState\.show/);
	assert.match(search, /isOwner:\s*!!cleanup/);
	assert.match(search, /query,\s*\n\s*starred:/);
});

test("bouton desactive avec la raison : texte unique de cleanupButtonState, libelle reel du filtre (WEB-4)", () => {
	assert.match(search, /import \{ cleanupButtonState \} from "@\/lib\/cleanup-search-button"/);
	const call = search.match(/cleanupButtonState\(\{[\s\S]*?\}\)/)?.[0] ?? "";
	assert.ok(call, "appel de cleanupButtonState absent");
	assert.match(call, /starred:\s*isStarred/);
	assert.match(call, /mailboxCleanable:\s*!!cleanup\?\.mailboxCleanable/);
	assert.match(call, /canExtend:\s*true/);
	// Le libelle cite est celui du Badge affiche a l'ecran, dans les deux langues.
	assert.match(call, /starredLabel:\s*k\("Starred only",\s*"Favoris uniquement"\)/);
	assert.match(search, /\{k\("Starred only",\s*"Favoris uniquement"\)\}/);
	assert.match(search, /disabled=\{Boolean\(cleanupState\.disabledReason\)\}/);
	// La raison est affichee (un bouton desactive n'a pas d'infobulle fiable), pas seulement en title.
	assert.match(search, /\{cleanupState\.disabledReason\s*&&/);
	// Plus de seconde copie des textes dans le composant.
	assert.doesNotMatch(search, /Un fil étoilé n'est jamais nettoyé|Ce dossier ne se nettoie pas/);
});

test("« Étendre à tous les dossiers » a cote du bouton, meme quand il y a des resultats (WEB-1)", () => {
	const row = search.match(/data-ss2i="search-cleanup"[\s\S]*?search-cleanup-reason[\s\S]*?<\/div>/)?.[0] ?? "";
	assert.ok(row, "ligne du bouton absente");
	assert.match(row, /data-ss2i="search-cleanup-extend"/);
	assert.match(row, /Étendre à tous les dossiers/);
	assert.match(row, /setAllFolders\(true\)/);
	// affiche seulement hors tous les dossiers quand le dossier courant ne se nettoie pas
	assert.match(row, /!allFolders\s*&&\s*!cleanup\.mailboxCleanable/);
});

test("transmet query, allFolders, filtres et dossier courant, jamais starred", () => {
	const m = search.match(/<KCleanupRule\b[\s\S]*?\/>/);
	assert.ok(m, "KCleanupRule absent");
	const jsx = m![0];
	for (const p of ["identityPublicId", "mailboxSlug", "mailboxName", "allFolders", "query", "hasAttachment", "onlyUnread", "onDone"]) {
		assert.match(jsx, new RegExp(`\\b${p}=`), `prop ${p} absente`);
	}
	assert.doesNotMatch(jsx, /starred/i);
	// L'instantane est pris au clic : la recherche ouverte derriere peut encore changer.
	assert.match(search, /setCleanupOpen\(true\)/);
	assert.match(search, /setOpen\(false\)/);
	const snap = search.match(/setCleanupSnap\(\{[\s\S]*?\}\)/);
	assert.ok(snap, "instantane absent");
	assert.doesNotMatch(snap![0], /starred/i);
});

test("l'en-tete serveur ne donne `cleanup` qu'au proprietaire, dossier relu en base", () => {
	assert.match(header, /ownerId/);
	assert.match(header, /isSignedIn|assertSignedIn/);
	assert.match(header, /CLEANUP_ALLOWED_KINDS/);
	assert.match(header, /mailboxCleanable/);
	assert.match(header, /cleanup=\{/);
	assert.match(header, /ownerId\s*===\s*user/);
});

test("note Nouveautes presente : recherche, duree, fils etoiles, Corbeille 30 jours, page des reglages", () => {
	const files = existsSync(CHANGELOGS) ? readdirSync(CHANGELOGS).filter((f) => /^2026-11-25(-\d+)?\.md$/.test(f)) : [];
	const notes = files.map((f) => readFileSync(join(CHANGELOGS, f), "utf8")).filter((t) => /Nettoyage auto/.test(t));
	assert.equal(notes.length, 1, "une note 2026-11-25[-N].md doit parler de « Nettoyage auto »");
	const t = notes[0];
	assert.match(t, /^---\ntitle: ".+"\n---/);
	assert.match(t, /recherche/i);
	assert.match(t, /étoilé/i);
	assert.match(t, /30 jours/);
	assert.match(t, /Nettoyage automatique/);
	assert.doesNotMatch(t, /\p{Extended_Pictographic}/u);
	// WEB-5 : le debit reel est 200 fils par passage de 15 minutes.
	assert.doesNotMatch(t, /quart d'heure/);
	assert.match(t, /par lots de 200 toutes les 15 minutes/);
	// WEB-1 : le libelle du bouton d'extension et la nouvelle interface (dossier courant seulement).
	assert.match(t, /Étendre à tous les dossiers/);
	assert.match(t, /nouvelle interface[^\n]*dossier courant/i);
	// WEB-4 : plus de libelle de filtre qui n'existe pas a l'ecran.
	assert.doesNotMatch(t, /Favoris uniquement/);
});

if (failed) {
	console.error(`\n${failed} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
