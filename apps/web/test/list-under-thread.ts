// Interface classique : la liste du dossier ne s'affiche plus sous un fil ouvert
// (Samuel le 06/11 : « c'est complètement con d'afficher deux fois la même chose »).
// En navigation douce, le layout garde la liste (children) sous le fil du slot
// @thread : le fil ouvert, souvent le plus recent, reapparaissait en premiere
// ligne. Option par utilisateur « Show folder list under an open conversation »,
// masquee par defaut. Sur chargement direct de l'URL d'un fil, children EST le
// fil : il ne faut jamais le masquer, donc on masque la liste dans la page du
// dossier (ClassicPage) et non {children} du layout.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/list-under-thread.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listIsHidden, pathHasThread, parseListUnderThread } from "../lib/list-under-thread";

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

const base = "/fr/w/w1/dashboard/mail/i1/inbox";

test("l'URL d'un fil est reconnue, celle du dossier non", () => {
	assert.equal(pathHasThread(`${base}/threads/abc-123`), true);
	assert.equal(pathHasThread(`${base}/threads/abc-123/`), true);
	assert.equal(pathHasThread(base), false);
	assert.equal(pathHasThread(`${base}?page=2`), false);
	assert.equal(pathHasThread(`${base}/threads/`), false);
	assert.equal(pathHasThread(null), false);
	assert.equal(pathHasThread(undefined), false);
});
test("masquee (defaut) : la liste disparait sous un fil, revient sans fil", () => {
	assert.equal(listIsHidden("hidden", `${base}/threads/abc`), true);
	assert.equal(listIsHidden("hidden", base), false);
});
test("affichee : comportement d'origine, la liste reste toujours", () => {
	assert.equal(listIsHidden("shown", `${base}/threads/abc`), false);
	assert.equal(listIsHidden("shown", base), false);
});
test("valeur inconnue ou absente : masquee", () => {
	assert.equal(parseListUnderThread(undefined), "hidden");
	assert.equal(parseListUnderThread(null), "hidden");
	assert.equal(parseListUnderThread("n'importe quoi"), "hidden");
	assert.equal(parseListUnderThread("shown"), "shown");
	assert.equal(parseListUnderThread("hidden"), "hidden");
});

const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => strip(readFileSync(join(__dirname, "..", p), "utf8"));
const dir = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]";

test("action : rangee dans workspaces.meta.ss2iListUnderThread[userId], sans table", () => {
	const src = read("lib/actions/list-under-thread.ts");
	assert.ok(/^"use server"/.test(src.trim()), "pas une action serveur");
	assert.ok(/ss2iListUnderThread/.test(src), "cle meta absente");
	assert.ok(/export async function listUnderThread\(/.test(src), "lecture absente");
	assert.ok(/export async function setListUnderThread\(/.test(src), "ecriture absente");
	assert.ok(/revalidatePath\(/.test(src), "pas de revalidation");
	assert.ok(!/pgTable|create table/i.test(src), "ne doit pas creer de table");
});
test("composant : chemin par usePathname (pas useParams), liste montee mais invisible et inert quand masquee (20/11)", () => {
	const p = "components/mailbox/default/list-slot.tsx";
	assert.ok(existsSync(join(__dirname, "..", p)), "list-slot.tsx absent");
	const src = read(p);
	assert.ok(/"use client"/.test(src));
	assert.ok(/usePathname\(/.test(src), "usePathname attendu");
	assert.ok(!/useParams\(/.test(src), "useParams interdit (ancien threadId dans le slot conserve)");
	assert.ok(/listIsHidden\(/.test(src) && /invisible/.test(src) && /inert=\{hidden\}/.test(src), "la liste n'est pas masquee");
	assert.ok(!/return null/.test(src), "la liste ne doit plus etre demontee (thread-pane.ts)");
});
test("page du dossier : seule la liste classique est enveloppee, la nouvelle interface intacte", () => {
	const src = read(`${dir}/[mailboxSlug]/page.tsx`);
	const classic = src.slice(src.indexOf("async function ClassicPage"), src.indexOf("async function NouvellePage"));
	const nouvelle = src.slice(src.indexOf("async function NouvellePage"), src.indexOf("async function Page("));
	assert.ok(/<ListSlot\b/.test(classic) && /<\/ListSlot>/.test(classic), "ClassicPage n'utilise pas ListSlot");
	assert.ok(/listUnderThread\(\)/.test(classic), "ClassicPage ne lit pas l'option");
	assert.ok(!/ListSlot|listUnderThread/.test(nouvelle), "la nouvelle interface ne doit pas changer");
});
test("layout : {children} n'est pas masque (sur chargement direct c'est le fil)", () => {
	const src = read(`${dir}/[mailboxSlug]/layout.tsx`);
	assert.ok(!/ListSlot/.test(src), "le layout ne doit pas masquer children");
	assert.ok(/MailboxSearchHeader/.test(src), "en-tete de recherche conserve");
});
test("reglages : interrupteur « Show folder list under an open conversation » cable", () => {
	const card = read("components/mailbox/settings/settings-unread-panel.tsx");
	assert.ok(/Show folder list under an open conversation/.test(card), "libelle absent");
	assert.ok(/setListUnderThread\(/.test(card), "ecriture non cablee");
	const page = read(`${dir}/settings/page.tsx`);
	assert.ok(/listUnderThread\(\)/.test(page), "la page des reglages ne lit pas l'option");
});
test("note Nouveautes 2026-11-06-4 presente et nomme l'interrupteur", () => {
	const note = readFileSync(join(__dirname, "../changelogs/2026-11-06-4.md"), "utf8");
	assert.ok(/^title:\s*".+"/m.test(note), "title absent");
	assert.ok(/Show folder list under an open conversation/.test(note), "libelle de l'interrupteur absent");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
