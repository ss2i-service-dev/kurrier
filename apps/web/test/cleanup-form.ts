// Nettoyage automatique depuis une recherche (MT10 de docs/plans/nettoyage-auto-recherche.md) : formulaire
// « Nettoyage auto... » partage par les deux interfaces. Une regle envoie des fils a la Corbeille de facon
// permanente et repetee : pas de creation sans un apercu reussi pour la duree et la portee affichees, une
// saisie libre jamais <= 0 ni non numerique (cleanupDaysFromFree rend null ou 1 pour ces saisies),
// jamais d'etoile en parametre. Logique pure dans lib/cleanup-form.ts, cablage verifie sur le source.
// Aucune base, aucun reseau. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/cleanup-form.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_PRESETS } from "../../../packages/common/src/cleanup-rules";
import {
	canCreateCleanup,
	cleanupFormPresets,
	cleanupFreeDays,
	cleanupSummary,
	durationLabel,
	previewKey,
} from "../lib/cleanup-form";

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

const nb = (s: string) => s.replace(/ /g, " ");

test("les six presets valent 7, 30, 91, 182, 365, 730 jours", () => {
	assert.deepEqual(
		cleanupFormPresets().map((p) => p.days),
		[7, 30, 91, 182, 365, 730],
	);
	assert.deepEqual(
		cleanupFormPresets().map((p) => p.label),
		["1 semaine", "1 mois", "3 mois", "6 mois", "1 an", "2 ans"],
	);
	assert.equal(cleanupFormPresets().length, CLEANUP_PRESETS.length);
});

test("saisie libre : unites jour, semaine, mois, an, bornee a 1..3650 jours", () => {
	assert.deepEqual(cleanupFreeDays("3", "day"), { days: 3 });
	assert.deepEqual(cleanupFreeDays("2", "week"), { days: 14 });
	assert.deepEqual(cleanupFreeDays("4", "month"), { days: 120 });
	assert.deepEqual(cleanupFreeDays("1", "year"), { days: 365 });
	assert.deepEqual(cleanupFreeDays("1,5", "month"), { days: 45 });
	assert.deepEqual(cleanupFreeDays(" 10 ", "year"), { days: 3650 });
	assert.deepEqual(cleanupFreeDays("99", "year"), { days: 3650 });
});

test("saisie libre : vide, zero, negative, non numerique, infinie : refusee, jamais une duree", () => {
	for (const v of ["", "   ", "0", "-1", "-5", "-Infinity", "Infinity", "abc", "1e999", "NaN", "0,0"]) {
		const r = cleanupFreeDays(v, "day");
		assert.ok("error" in r && r.error.length > 0, `« ${v} » doit etre refusee : ${JSON.stringify(r)}`);
		assert.ok(!("days" in r), `« ${v} » ne doit rendre aucune duree`);
	}
});

test("durationLabel : libelle du preset, sinon jours", () => {
	assert.equal(durationLabel(7), "1 semaine");
	assert.equal(durationLabel(730), "2 ans");
	assert.equal(durationLabel(45), "45 jours");
	assert.equal(durationLabel(1), "1 jour");
});

test("creation impossible sans apercu reussi pour la duree et la portee affichees", () => {
	const ok = { matching: 12, dueNow: 3, truncated: false };
	const key = previewKey({ identityPublicId: "i", mailboxSlug: "inbox", allFolders: false, query: "banque", hasAttachment: false, onlyUnread: false, retentionDays: 30 });
	assert.equal(canCreateCleanup({ preview: null, previewKey: null, key, busy: false }), false);
	assert.equal(canCreateCleanup({ preview: ok, previewKey: key, key, busy: false }), true);
	// apercu d'une autre duree ou d'une autre portee
	const other = previewKey({ identityPublicId: "i", mailboxSlug: "inbox", allFolders: false, query: "banque", hasAttachment: false, onlyUnread: false, retentionDays: 7 });
	assert.equal(canCreateCleanup({ preview: ok, previewKey: other, key, busy: false }), false);
	// pas de duree choisie, ou action en cours
	assert.equal(canCreateCleanup({ preview: ok, previewKey: key, key: null, busy: false }), false);
	assert.equal(canCreateCleanup({ preview: ok, previewKey: key, key, busy: true }), false);
});

test("previewKey change avec la duree, la portee, le texte et les filtres", () => {
	const base = { identityPublicId: "i", mailboxSlug: "inbox", allFolders: false, query: "banque", hasAttachment: false, onlyUnread: false, retentionDays: 30 };
	const k = previewKey(base);
	for (const change of [{ retentionDays: 7 }, { allFolders: true }, { query: "relevé" }, { hasAttachment: true }, { onlyUnread: true }, { mailboxSlug: "archive" }]) {
		assert.notEqual(previewKey({ ...base, ...change }), k, JSON.stringify(change));
	}
});

const BASE = { query: "banque", mailboxName: "Boîte de réception", allFolders: false, hasAttachment: false, onlyUnread: false, days: 30 };

test("recapitulatif : texte, portee, comptes, suite, etoiles, Corbeille 30 jours", () => {
	const lines = cleanupSummary({ ...BASE, preview: { matching: 12, dueNow: 3, truncated: false } }).map(nb);
	const all = lines.join("\n");
	assert.match(all, /banque/);
	assert.match(all, /Boîte de réception/);
	assert.ok(lines.some((l) => /12 fils correspondent exactement \(sans tolérance aux fautes de frappe\)/.test(l)), all);
	assert.ok(lines.some((l) => /3 fils partent à la Corbeille dans le quart d'heure/.test(l)), all);
	assert.ok(lines.some((l) => /ensuite, chaque fil sans nouveau message depuis 1 mois/i.test(l)), all);
	assert.ok(lines.some((l) => /fils étoilés (ne sont jamais concernés|restent)/i.test(l)), all);
	assert.ok(lines.some((l) => /Corbeille se vide au bout de 30 jours/.test(l)), all);
});

test("recapitulatif : pluriel et zero", () => {
	const one = cleanupSummary({ ...BASE, preview: { matching: 1, dueNow: 1, truncated: false } }).map(nb).join("\n");
	assert.match(one, /1 fil correspond exactement/);
	assert.match(one, /1 fil part à la Corbeille/);
	const zero = cleanupSummary({ ...BASE, preview: { matching: 0, dueNow: 0, truncated: false } }).map(nb).join("\n");
	assert.match(zero, /Aucun fil ne correspond exactement/);
	assert.match(zero, /Aucun fil ne part à la Corbeille dans le quart d'heure/);
});

test("recapitulatif : apercu tronque, « plus de N »", () => {
	const all = cleanupSummary({ ...BASE, preview: { matching: 5000, dueNow: 2000, truncated: true } }).map(nb).join("\n");
	assert.match(all, /Plus de 2 000 fils partent à la Corbeille/);
	assert.match(all, /5 000 fils correspondent exactement/);
});

test("recapitulatif : portee et filtres", () => {
	const all = cleanupSummary({ ...BASE, allFolders: true, hasAttachment: true, onlyUnread: true, preview: { matching: 2, dueNow: 0, truncated: false } }).map(nb).join("\n");
	assert.match(all, /Tous les dossiers/);
	assert.match(all, /avec pièce jointe/);
	assert.match(all, /non lus/);
	const sans = cleanupSummary({ ...BASE, preview: { matching: 2, dueNow: 0, truncated: false } }).map(nb).join("\n");
	assert.doesNotMatch(sans, /pièce jointe/);
	assert.doesNotMatch(sans, /non lus/);
});

test("aucun emoji dans les textes du recapitulatif", () => {
	const all = cleanupSummary({ ...BASE, preview: { matching: 2, dueNow: 1, truncated: true } }).join("\n");
	assert.doesNotMatch(all, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

const FORM = "apps/web/components/k/cleanup-rule-form.tsx";
const form = read(FORM);

test("composant : fichier client, export par defaut, props du plan", () => {
	assert.ok(form, `${FORM} absent`);
	assert.match(readFileSync(join(ROOT, FORM), "utf8").trimStart(), /^"use client";/);
	assert.match(form, /export default function KCleanupRule\(/);
	for (const p of ["identityPublicId", "mailboxSlug", "mailboxName", "allFolders", "query", "hasAttachment", "onlyUnread", "onDone"]) {
		assert.match(form, new RegExp(`\\b${p}\\b`), `prop ${p}`);
	}
});

test("composant : apercu par previewCleanupRule, creation par createCleanupRule gardee par canCreateCleanup", () => {
	assert.match(form, /previewCleanupRule\(/);
	assert.match(form, /createCleanupRule\(/);
	assert.match(form, /canCreateCleanup\(/);
	assert.match(form, /@\/lib\/actions\/cleanup-rules/);
	// le bouton de creation est desactive hors apercu reussi
	assert.match(form, /disabled=\{!can\b/);
	// la creation relit la garde avant d'appeler l'action
	const create = form.match(/async function create\([\s\S]*?\n\t\}\n/)?.[0] ?? "";
	assert.match(create, /canCreateCleanup\(/);
	assert.ok(create.indexOf("canCreateCleanup(") < create.indexOf("createCleanupRule("), "garde apres l'appel");
});

test("composant : saisie libre par cleanupFreeDays, erreur du serveur affichee telle quelle, lien vers les reglages", () => {
	assert.match(form, /cleanupFreeDays\(/);
	assert.match(form, /res\.error/);
	assert.match(form, /settings\/cleanup/);
	assert.match(form, /useNouvelle\(\)/);
	assert.match(form, /CLEANUP_MAX_DAYS|cleanupFreeDays/);
});

test("composant : jamais d'etoile, d'identifiant de dossier ni de workspace transmis", () => {
	assert.doesNotMatch(form, /starred/i);
	assert.doesNotMatch(form, /workspacePublicId|mailboxId\b|identityId\b/);
});

test("composant : aucun emoji, aucun AM/PM", () => {
	assert.doesNotMatch(readFileSync(join(ROOT, FORM), "utf8"), /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\bAM\b|\bPM\b/u);
});

if (failed) {
	console.error(`\n${failed} test(s) en echec`);
	process.exit(1);
}
console.log("\ntous les tests passent");
