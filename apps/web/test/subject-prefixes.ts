// Objet sans préfixe de réponse ni de transfert (Samuel le 06/11 : « tous les mails qu'on
// a, ils se retrouvent avec des RE:, des forward: »). Fonction pure, câblage de l'envoi
// (compose.ts, réponse et transfert), de l'éditeur, de Lore et des affichages de l'objet.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/subject-prefixes.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripSubjectPrefixes } from "../../../packages/common/src/subject";
import { composeMessage } from "../../../packages/common/src/compose";
import { loreReplySubject } from "../../../packages/common/src/lore-reply";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`);
	}
}

test("préfixes empilés, toutes casses et langues", () => {
	const cases: [string, string][] = [
		["RE: TR: RE: Devis serveur", "Devis serveur"],
		["Re: Fwd: FW: Devis", "Devis"],
		["re:Devis", "Devis"],
		["AW: WG: Angebot", "Angebot"],
		["Re[2]: RE(3): Point", "Point"],
		["RE : Facture", "Facture"],
		["Réf：x", "Réf：x"],
		["TR： Relance", "Relance"],
		["  Fwd:   ", ""],
		["Devis", "Devis"],
		["Recrutement: profil", "Recrutement: profil"],
		["Tri: dossiers", "Tri: dossiers"],
		["Point RE: suite", "Point RE: suite"],
	];
	for (const [input, want] of cases) assert.equal(stripSubjectPrefixes(input), want, input);
	assert.equal(stripSubjectPrefixes(null), "");
	assert.equal(stripSubjectPrefixes(undefined), "");
});

const orig = { html: "<p>Bonjour</p>", text: "Bonjour", subject: "RE: TR: Devis serveur", fromName: "Maud", fromAddress: "maud@exemple.fr", dateLabel: "6 nov. 2026" };

test("envoi : réponse et transfert sans préfixe", () => {
	assert.equal(composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig }).subject, "Devis serveur");
	assert.equal(composeMessage({ mode: "forward", text: "ok", html: "<p>ok</p>", orig }).subject, "Devis serveur");
	assert.equal(composeMessage({ mode: "reply", orig: { ...orig, subject: "" } }).subject, "(no subject)");
});

test("envoi : l'objet saisi dans l'éditeur prime, nettoyé", () => {
	assert.equal(composeMessage({ mode: "reply", subject: "Re: Devis corrigé", orig }).subject, "Devis corrigé");
	assert.equal(composeMessage({ mode: "forward", subject: "Pour info", orig }).subject, "Pour info");
});

test("Lore : brouillon sans préfixe", () => {
	assert.equal(loreReplySubject("RE: TR: Devis"), "Devis");
});

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("éditeur : objet calculé sans préfixe", () => {
	const src = read("components/mailbox/default/editor/editor-header.tsx");
	assert.ok(src.includes("stripSubjectPrefixes"), "editor-header.tsx doit utiliser stripSubjectPrefixes");
	assert.ok(!/`(Re|Fwd): \$\{/.test(src), "editor-header.tsx ne doit plus préfixer l'objet");
});

test("affichages : listes et fils montrent l'objet nettoyé", () => {
	for (const p of [
		"components/mailbox/default/webmail-list-item.tsx",
		"components/mailbox/default/webmail-list-item-mobile.tsx",
		"components/mailbox/default/email-renderer.tsx",
		"components/mailbox/default/unread-panel.tsx",
		"components/mailbox/default/mailbox-search.tsx",
		"components/k/thread-row.tsx",
		"components/k/thread-page.tsx",
	]) {
		assert.ok(read(p).includes("stripSubjectPrefixes("), `${p} doit afficher stripSubjectPrefixes(...)`);
	}
});

if (failed) {
	console.log(`\n${failed} échec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
