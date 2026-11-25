// Nettoyage automatique depuis une recherche (MT9 de docs/plans/nettoyage-auto-recherche.md) : page des
// reglages qui liste les regles de l'identite, avec Suspendre/Reprendre et Supprimer, atteignable depuis la
// navigation classique et la navigation k. Test de cablage sur les sources. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/cleanup-settings.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

const PAGE = "apps/web/app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/settings/cleanup/page.tsx";
const LIST = "apps/web/components/mailbox/settings/cleanup-rules-list.tsx";
const TABS = "apps/web/components/mailbox/settings/settings-tabs.tsx";
const SHELL = "apps/web/components/k/settings-shell.tsx";

const page = read(PAGE);
const list = read(LIST);

test("page et composant presents", () => {
	assert.ok(page, `${PAGE} absent`);
	assert.ok(list, `${LIST} absent`);
	assert.match(list.trimStart(), /^"use client";/);
});

test("navigation classique et navigation k pointent sur /settings/cleanup", () => {
	for (const f of [TABS, SHELL]) {
		const src = read(f);
		assert.ok(src, `${f} absent`);
		// Le shell k part de `base` (= .../settings), la navigation classique ecrit le chemin entier.
		assert.match(src, /\/settings\/cleanup`|\$\{base\}\/cleanup`/, `${f} : entree vers /settings/cleanup absente`);
		assert.match(src, /Nettoyage automatique/, `${f} : libelle absent`);
	}
});

test("la page lit les regles par listCleanupRules et distingue le non-proprietaire", () => {
	assert.match(page, /listCleanupRules\(/);
	assert.match(page, /identityPublicId/);
	assert.match(page, /ownerId\s*!==\s*user\.id|user\.id\s*!==\s*[\w.]*ownerId|ownerId\s*===\s*user\.id/);
	assert.match(page, /assertIdentityAccess/);
	assert.match(page, /assertSignedIn/);
});

test("non-proprietaire : phrase de lecture, la liste n'est pas rendue", () => {
	assert.match(page, /propri[ée]taire de (cette|la) bo[iî]te/i);
	// Le composant de liste n'est rendu que dans la branche propriétaire.
	assert.match(page, /isOwner[\s\S]*<CleanupRulesList|<CleanupRulesList[\s\S]*isOwner/);
});

test("le composant appelle setCleanupRulePaused et deleteCleanupRule", () => {
	assert.match(list, /setCleanupRulePaused\(/);
	assert.match(list, /deleteCleanupRule\(/);
});

test("suppression avec confirmation, action en cours visible, erreur affichee", () => {
	assert.match(list, /confirm|modals\.openConfirmModal|Confirmer/i);
	assert.match(list, /loading=\{/);
	assert.match(list, /toast\.error\(/);
	assert.match(list, /toast\.success\(/);
});

test("liste vide : phrase qui renvoie a la recherche", () => {
	assert.match(list, /depuis une recherche/);
});

test("une ligne : portee, filtres, duree, compteur, suspendre ou reprendre", () => {
	assert.match(list, /Suspendre/);
	assert.match(list, /Reprendre/);
	assert.match(list, /Supprimer/);
	assert.match(list, /au-delà de/);
	assert.match(list, /trashedCount/);
	assert.match(list, /lastTrashedAt/);
	assert.match(list, /hasAttachment/);
	assert.match(list, /onlyUnread/);
	assert.match(list, /allFolders|mailboxName/);
});

test("dates en 24 h, jamais AM/PM", () => {
	assert.doesNotMatch(list, /hour12:\s*true/);
	if (/toLocale(Date|Time)?String|DateTimeFormat/.test(list)) {
		assert.match(list, /fr-FR|hourCycle:\s*["']h23["']/);
	}
});

test("aucun emoji", () => {
	const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}]/u;
	assert.doesNotMatch(page, emoji);
	assert.doesNotMatch(list, emoji);
});

if (failed) {
	console.error(`${failed} test(s) en echec`);
	process.exit(1);
}
console.log("ok   nettoyage automatique : reglages");
