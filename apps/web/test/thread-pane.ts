// Interface classique : le mail ouvert defile seul, la liste ne bouge jamais. Samuel le 20/11/2026 :
// « j'ouvre un mail, je scrolle dans mon mail, je ferme le mail, oh bah la liste de mes mails elle
// a scrolle aussi [...] que ce soit sur mobile ou desktop ». Troisieme signalement (05/11, 19/11) :
// la liste et le fil defilaient dans le meme document, la liste etait demontee (ListSlot rendait
// null) puis remontee en streaming, et la position etait retablie apres coup, trop tot.
// Correctif structurel, option « liste masquee sous le fil » (defaut) :
//   1) le fil s'ouvre dans un panneau fixe sous la barre du haut, qui a son propre defilement
//      (overflow-y-auto, overscroll-contain) et prend le focus ; le document est bloque ;
//   2) la liste reste montee dessous, invisible et inert : sa hauteur et le scrollY du document
//      ne changent pas, rien a retablir a la fermeture ;
//   3) useListReturn ne fait plus de scrollTo dans ce mode ; les raccourcis ignorent ce qui est inert.
// Option « liste affichee sous le fil » : comportement d'avant, inchange.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/thread-pane.ts
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

const web = join(__dirname, "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");
const layout = read(
	"app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/[mailboxSlug]/layout.tsx",
);
const threadSlot = read("components/mailbox/default/thread-slot.tsx");
const listSlot = read("components/mailbox/default/list-slot.tsx");
const lists = ["components/mailbox/default/webmail-list.tsx", "components/mailbox/default/webmail-list-label-search.tsx"];
const listReturn = read("lib/list-return.ts");
const shortcuts = read("public/ss2i-shortcuts.js");
const unreadPanel = read("components/mailbox/default/unread-panel.tsx");

test("layout classique : l'option liste sous le fil est lue et partagee avec le fil et les listes", () => {
	assert.match(layout, /await listUnderThread\(\)/);
	assert.match(layout, /<ListUnderThreadProvider mode=\{listMode\}>/);
});

test("ThreadSlot : panneau fixe a defilement propre en mode masque", () => {
	assert.match(threadSlot, /<ThreadPane/);
	const pane = read("components/mailbox/default/thread-pane.tsx");
	assert.match(pane, /fixed/);
	assert.match(pane, /overflow-y-auto/);
	assert.match(pane, /overscroll-contain/);
	assert.match(pane, /top-\[var\(--ss2i-mail-header-h,0px\)\]/);
	assert.match(pane, /html\.style\.overflow = "hidden"/, "document bloque tant que le fil est ouvert");
	assert.match(pane, /focus\(\{ preventScroll: true \}\)/, "Espace, PageDown, fleches defilent le fil");
	assert.match(pane, /scrollTop = 0/, "chaque fil commence en haut du panneau");
	assert.match(pane, /ResizeObserver/, "le panneau suit la largeur de la colonne (barre laterale)");
});

test("panneau cale sous le bas reel de la barre du haut, bandeau de rappel d'agenda compris (Samuel le 23/11)", () => {
	const pane = read("components/mailbox/default/thread-pane.tsx");
	assert.match(read("components/mailbox/mailbox-search-header.tsx"), /data-ss2i-mail-header=""/);
	assert.match(pane, /querySelector\("\[data-ss2i-mail-header\]"\)/);
	assert.match(pane, /getBoundingClientRect\(\)\.bottom/, "le haut du panneau suit le bas de la barre, pas sa hauteur");
	assert.match(pane, /ro\.observe\(document\.body\)/, "bandeau ferme ou ouvert : le panneau se recale");
});

test("panneau seulement par-dessus une liste montee (chargement direct d'un fil : dans le flux, comme avant)", () => {
	assert.match(threadSlot, /useListUnderThread\(\) === "hidden" && listMounted/);
	assert.match(listSlot, /useMarkListMounted\(\)/);
	assert.match(read("components/mailbox/default/email-renderer.tsx"), /el\.closest\("\[data-ss2i-thread-pane\]"\)/, "Repondre fait defiler le panneau, jamais le document");
});

test("barre Back mobile collee en haut du panneau, pas sous la barre du document", () => {
	assert.match(threadSlot, /pane \? "top-0" : "top-\[var\(--ss2i-mail-header-h,0px\)\]"/);
});

test("ListSlot : la liste reste montee, invisible et inert, au lieu d'etre demontee", () => {
	assert.doesNotMatch(listSlot, /return null/);
	assert.match(listSlot, /inert/);
	assert.match(listSlot, /invisible/);
});

for (const f of lists) {
	const src = read(f);
	test(`${f} : jamais display:none en mode masque (la hauteur du document serait perdue)`, () => {
		assert.match(src, /useListUnderThread\(\) === "hidden"/);
		assert.match(src, /className=\{onThread \? \(pane \? "invisible" : "hidden"\) : ""\}/);
		assert.match(src, /inert=\{onThread && pane\}/);
		assert.match(src, /useListReturn\(\s*pathname,[\s\S]*?\bpane,?\s*\);/);
	});
}

test("useListReturn : aucun scrollTo du document quand le fil est dans le panneau", () => {
	assert.match(listReturn, /export function useListReturn\(pathname: string \| null, visibleIds: string\[\], pane = false\)/);
	assert.match(listReturn, /if \(pane\) return;/);
});

test("raccourcis : un element inert (liste sous le panneau) n'est jamais vise", () => {
	assert.match(shortcuts, /const visible = \(el\) => el && el\.offsetParent !== null && !el\.closest\("\[inert\]"\);/);
	assert.match(shortcuts, /querySelectorAll\("button, a\[role=button\]"\)\)\.filter\(\(b\) => !b\.closest\("\[inert\]"\)\)/);
	assert.match(shortcuts, /document\.querySelectorAll\(`button\[data-ss2i-shortcut="\$\{marque\}"\]`\)\s*\)\.find\(visible\)/);
});

test("panneau des non-lus colle en haut du panneau du fil", () => {
	assert.match(unreadPanel, /inPane \?/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
