// Interface classique, mobile et ordinateur : la barre d'actions de la liste (tout
// selectionner, actualiser, archiver, supprimer, ecrire) disparaissait des le premier
// defilement (Samuel le 13/11 : « les controles restent masques des qu'on scrolle vers le
// bas »). Elle etait collante en top-0, comme la barre du haut (recherche, identite, z-50)
// qui la recouvrait : 74 px sur ordinateur, 134 px sur un ecran de 390 px ou la recherche
// passait sur trois lignes. Elle se colle maintenant sous la barre du haut, dont la hauteur
// est publiee dans --ss2i-mail-header-h ; la barre du haut tient sur une ligne en mobile, et
// un fil ouvert sur mobile a une barre de retour.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/mobile-header.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const VAR = "--ss2i-mail-header-h";

test("la barre du haut publie sa hauteur", () => {
	const header = src("components/mailbox/mailbox-search-header.tsx");
	assert.match(header, /<MailHeaderHeight \/>/);
	assert.match(header, /sticky top-0/);
	const comp = src("components/mailbox/mail-header-height.tsx");
	assert.ok(comp.includes(`"${VAR}"`), "nom de la variable");
	assert.match(comp, /ResizeObserver/);
	assert.match(comp, /removeProperty\(MAIL_HEADER_VAR\)/, "variable retiree hors des vues courrier");
});
test("la barre d'actions de la liste se colle sous la barre du haut, pas en top-0", () => {
	const list = src("components/mailbox/default/mail-list-header.tsx");
	assert.ok(list.includes(`sticky top-[var(${VAR},0px)]`));
	assert.doesNotMatch(list, /className="sticky top-0/);
});
test("la barre de retour d'un fil (mobile) se colle sous la barre du haut (ou en haut du panneau du fil, 20/11)", () => {
	const slot = src("components/mailbox/default/thread-slot.tsx");
	assert.ok(slot.includes(`"top-[var(${VAR},0px)]"`));
	assert.ok(slot.includes(`pane ? "top-0"`));
	assert.match(slot, /md:hidden/);
	assert.match(slot, /leaveThreadToList\(router/);
});
test("mobile : recherche sur une ligne, identite reduite a la roue", () => {
	const search = src("components/mailbox/default/mailbox-search.tsx");
	assert.match(search, /min-w-0 flex-1[^"]*"/);
	assert.match(search, /truncate text-sm/);
	const id = src("components/mailbox/settings/identity-settings.tsx");
	assert.match(id, /shrink-0 md:hidden/);
	assert.match(id, /hidden shrink-0 md:block/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\nmobile-header : tout est vert");
