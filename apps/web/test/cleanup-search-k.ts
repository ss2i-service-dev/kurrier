// Bouton « Nettoyage auto... » de la recherche de la nouvelle interface (docs/plans/nettoyage-auto-recherche.md, MT12).
// Visible si la requete n'est pas vide et que l'utilisateur est proprietaire de l'identite ; desactive, avec une
// explication, quand le filtre « etoile » est actif (un fil etoile n'est jamais nettoye) ou que le dossier courant
// n'est pas nettoyable hors « tous les dossiers » ; ne transmet jamais « starred ». Logique pure dans
// lib/cleanup-search-button.ts, cablage verifie sur le source. Aucune base, aucun reseau. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/cleanup-search-k.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupButtonState } from "../lib/cleanup-search-button";

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
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "");
const read = (p: string) => strip(raw(p));

const BASE = { isOwner: true, query: "banque", starred: false, mailboxKind: "inbox", allFolders: false };

test("visible : requete non vide et proprietaire, dossier nettoyable", () => {
	for (const mailboxKind of ["inbox", "archive", "custom"]) {
		assert.deepEqual(cleanupButtonState({ ...BASE, mailboxKind }), { show: true, disabledReason: null }, mailboxKind);
	}
});

test("masque : requete vide ou blanche, ou non proprietaire", () => {
	assert.deepEqual(cleanupButtonState({ ...BASE, query: "" }), { show: false });
	assert.deepEqual(cleanupButtonState({ ...BASE, query: "   " }), { show: false });
	assert.deepEqual(cleanupButtonState({ ...BASE, isOwner: false }), { show: false });
});

test("desactive avec explication : filtre etoile actif, meme en tous les dossiers", () => {
	for (const allFolders of [false, true]) {
		const s = cleanupButtonState({ ...BASE, starred: true, allFolders });
		assert.ok(s.show && s.disabledReason && /étoilé/.test(s.disabledReason), JSON.stringify(s));
	}
});

test("desactive avec explication : dossier non nettoyable hors tous les dossiers", () => {
	for (const mailboxKind of ["trash", "spam", "drafts", "sent", "outbox", "junk", null]) {
		const s = cleanupButtonState({ ...BASE, mailboxKind });
		assert.ok(s.show && s.disabledReason && /dossier/.test(s.disabledReason), `${mailboxKind} : ${JSON.stringify(s)}`);
		assert.deepEqual(cleanupButtonState({ ...BASE, mailboxKind, allFolders: true }), { show: true, disabledReason: null }, `${mailboxKind} en tous les dossiers`);
	}
});

const BTN = "apps/web/components/k/cleanup-search-button.tsx";
const HEAD = "apps/web/components/k/search-header.tsx";
const btn = read(BTN);
const head = read(HEAD);

test("bouton : composant client, attribut data-k-action=\"cleanup-rule\", Modal autour de KCleanupRule", () => {
	assert.ok(btn, `${BTN} absent`);
	assert.match(raw(BTN).trimStart(), /^"use client";/);
	assert.match(btn, /data-k-action="cleanup-rule"/);
	assert.match(btn, /import KCleanupRule from "@\/components\/k\/cleanup-rule-form"/);
	assert.match(btn, /<Modal\b[\s\S]*?<KCleanupRule\b[\s\S]*?<\/Modal>/);
	assert.match(btn, /cleanupButtonState\(/);
});

test("bouton : transmet les props du formulaire, onDone ferme la modale", () => {
	const props = btn.match(/<KCleanupRule\b[\s\S]*?\/>/)?.[0] ?? "";
	assert.ok(props, "KCleanupRule non rendu");
	for (const p of ["identityPublicId", "mailboxSlug", "mailboxName", "allFolders", "query", "hasAttachment", "onlyUnread", "onDone"]) {
		assert.match(props, new RegExp(`\\b${p}\\b`), `prop ${p}`);
	}
	assert.match(props, /onDone=\{[^}]*close/);
});

test("bouton : lit la recherche dans l'URL, jamais starred vers le formulaire", () => {
	assert.match(btn, /useSearchParams\(/);
	assert.match(btn, /get\("q"\)/);
	assert.match(btn, /get\("has"\)/);
	assert.match(btn, /get\("unread"\)/);
	assert.match(btn, /get\("starred"\)/);
	const props = btn.match(/<KCleanupRule\b[\s\S]*?\/>/)?.[0] ?? "";
	assert.doesNotMatch(props, /starred/i);
	assert.doesNotMatch(btn, /createCleanupRule|previewCleanupRule|starred:/);
});

test("bouton : visible seulement sur la page de resultats, desactive avec l'explication visible", () => {
	assert.match(btn, /usePathname\(/);
	assert.match(btn, /\/search/);
	assert.match(btn, /disabled=\{Boolean\(state\.disabledReason\)\}/);
	assert.match(btn, /state\.disabledReason/);
});

test("en-tete k : proprietaire et dossier relus en base, transmis au bouton", () => {
	assert.match(head, /import KCleanupSearchButton from "@\/components\/k\/cleanup-search-button"/);
	assert.match(head, /<KCleanupSearchButton\b/);
	assert.match(head, /isOwner/);
	assert.match(head, /ownerId/);
	assert.match(head, /mailboxKind/);
	assert.match(head, /mailboxes\.kind/);
	assert.match(head, /identityPublicId/);
	// la recherche et ses boutons existants restent
	assert.match(head, /<MailboxSearch\b/);
	assert.match(head, /<MobileNavButton\b/);
});

test("aucun emoji, aucun AM/PM", () => {
	for (const p of [BTN, HEAD, "apps/web/lib/cleanup-search-button.ts"]) {
		assert.doesNotMatch(raw(p), /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\bAM\b|\bPM\b/u, p);
	}
});

if (failed) {
	console.error(`\n${failed} test(s) en echec`);
	process.exit(1);
}
console.log("\ntous les tests passent");
