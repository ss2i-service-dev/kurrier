// Titre et icone de l'onglet selon la section (Samuel le 06/11 : « il faut un truc qui
// permette de reperer visuellement si c'est une tab de client mail ou une tab de calendrier
// qui est ouvert »). Tous les onglets s'appelaient « Kurrier » avec la meme icone.
// Chaque layout de section exporte tabMetadata(section) : titre propre et favicon SVG propre.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/tab-identity.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TAB_SECTIONS, tabMetadata, tabSectionOf, tabTitle } from "../lib/tab-identity";

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

const web = join(__dirname, "..");
const unified = join(web, "app/[locale]/w/[wPublicId]/dashboard/(unified)");

test("mail : titre Courrier", () => {
	assert.equal(tabMetadata("mail").title, "Courrier");
});
test("calendrier et agenda : titres distincts du mail", () => {
	assert.equal(tabMetadata("calendar").title, "Calendrier");
	assert.equal(tabMetadata("agenda").title, "Agenda");
});
test("mail et calendrier n'ont pas la meme icone", () => {
	const icon = (s: keyof typeof TAB_SECTIONS) => (tabMetadata(s).icons as any).icon[0].url;
	assert.notEqual(icon("mail"), icon("calendar"));
	assert.equal(icon("calendar"), icon("agenda"));
});
test("chaque icone existe dans public/ et est un SVG", () => {
	for (const s of Object.values(TAB_SECTIONS)) {
		if (!s.icon) continue;
		const file = join(web, "public", s.icon);
		assert.ok(existsSync(file), `${s.icon} absent de public/`);
		assert.match(readFileSync(file, "utf8"), /<svg[\s>]/);
	}
});
test("chaque layout de section exporte tabMetadata de sa section", () => {
	const dirs: Record<string, string> = {
		mail: "(mail)",
		calendar: "(calendar)",
		agenda: "(agenda)",
		contacts: "(contacts)",
		drive: "(drive)",
		platform: "(platform)",
	};
	for (const [section, dir] of Object.entries(dirs)) {
		const src = readFileSync(join(unified, dir, "layout.tsx"), "utf8");
		assert.ok(
			src.includes(`export const metadata = tabMetadata("${section}")`),
			`${dir}/layout.tsx n'exporte pas tabMetadata("${section}")`,
		);
	}
});

const ws = "/en/w/abc/dashboard";
test("nouvelle interface : titre du mail avec dossier et non lus", () => {
	assert.equal(tabTitle(`${ws}/mail/id1/inbox`, 3), "(3) Courrier - Boîte de réception");
	assert.equal(tabTitle(`${ws}/mail/id1/sent`, 0), "Courrier - Envoyés");
	assert.equal(tabTitle(`${ws}/mail/id1/inbox/search`, 0), "Courrier - Recherche");
	assert.equal(tabTitle(`${ws}/mail/id1/perso-xyz`, 0, "Factures"), "Courrier - Factures");
	assert.equal(tabTitle(`${ws}/mail`, 0), "Courrier");
});
test("nouvelle interface : agenda et calendrier gardent leur nom, sans compteur", () => {
	// Avant : « (3) Kurrier - Messagerie » sur l'agenda.
	assert.equal(tabTitle(`${ws}/agenda`, 3), "Agenda");
	assert.equal(tabTitle(`${ws}/calendar/xyz`, 3), "Calendrier");
	assert.equal(tabTitle(`${ws}/contacts`, 2), "Contacts");
});
test("section d'apres le chemin", () => {
	assert.equal(tabSectionOf(`${ws}/agenda`), "agenda");
	assert.equal(tabSectionOf(`${ws}/calendar`), "calendar");
	assert.equal(tabSectionOf(`${ws}/mail/id1/inbox/threads/t1`), "mail");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
