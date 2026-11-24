// Interface classique (style Gmail), mail ouvert : deux appuis sur Echap ferment le mail et
// ramenent a la liste (Samuel le 24/11/2026 : « en mode gmail, dans un courrier ouvert, deux appuis
// sur esc doivent cloturer le mail et ramener sur la liste des mails »). Avant, Echap ne fermait le
// fil que dans la nouvelle interface (fermer() rendait false hors data-ui="ss2i").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const WEB = join(__dirname, "..");
const code = (p: string) =>
	readFileSync(join(WEB, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sh = code("public/ss2i-shortcuts.js");

type Etat = { nouvelle: boolean; url: string; ouvert: string | null; now: number; clics: string[] };

// Rejoue fermer() du script avec un document et une horloge simules.
function charger(etat: Etat) {
	const m = sh.match(/(let dernierEchap[^\n]*\n)?[\s\S]*?(const fermer = \(\) => \{[\s\S]*?\n  \};)/);
	assert.ok(m, "fonction fermer");
	const decl = sh.match(/let dernierEchap = [^;]*;/);
	const bouton = { click: () => etat.clics.push("leave-thread") };
	const document = {
		querySelector: (sel: string) => {
			if (sel.includes('role="dialog"') || sel.includes('role="menu"')) return etat.ouvert;
			if (sel.includes('data-ss2i-shortcut="leave-thread"')) return /\/threads\//.test(etat.url) ? bouton : null;
			return null;
		},
	};
	const Date = { now: () => etat.now };
	const nouvelle = () => etat.nouvelle;
	const dansUnMail = () => /\/threads\/[^/]+/.test(etat.url);
	const cliquerK = (a: string) => (etat.clics.push(`k:${a}`), true);
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	return new Function(
		"document",
		"Date",
		"nouvelle",
		"dansUnMail",
		"cliquerK",
		`${decl ? decl[0] : ""}\n${m![2]}\nreturn fermer;`,
	)(document, Date, nouvelle, dansUnMail, cliquerK) as () => boolean;
}

const base = (): Etat => ({ nouvelle: false, url: "/w/x/dashboard/mail/i/inbox/threads/abc", ouvert: null, now: 1000, clics: [] });

test("classique, mail ouvert : un seul Echap ne ferme pas", () => {
	const e = base();
	const fermer = charger(e);
	assert.equal(fermer(), false);
	assert.deepEqual(e.clics, []);
});

test("classique, mail ouvert : deux Echap rapproches ferment le mail", () => {
	const e = base();
	const fermer = charger(e);
	fermer();
	e.now += 400;
	assert.equal(fermer(), true);
	assert.deepEqual(e.clics, ["leave-thread"]);
});

test("classique : deux Echap trop espaces ne ferment pas, le second recommence le compte", () => {
	const e = base();
	const fermer = charger(e);
	fermer();
	e.now += 3000;
	assert.equal(fermer(), false);
	e.now += 300;
	assert.equal(fermer(), true);
	assert.deepEqual(e.clics, ["leave-thread"]);
});

test("classique : un Echap qui ferme un menu ou une fenetre ne compte pas", () => {
	const e = base();
	const fermer = charger(e);
	e.ouvert = "menu";
	assert.equal(fermer(), false);
	e.ouvert = null;
	e.now += 300;
	assert.equal(fermer(), false, "le premier Echap apres le menu n'est que le premier");
	e.now += 300;
	assert.equal(fermer(), true);
});

test("classique, sur la liste : Echap Echap ne fait rien", () => {
	const e = base();
	e.url = "/w/x/dashboard/mail/i/inbox";
	const fermer = charger(e);
	fermer();
	e.now += 200;
	assert.equal(fermer(), false);
	assert.deepEqual(e.clics, []);
});

test("nouvelle interface : un Echap ferme toujours le fil", () => {
	const e = base();
	e.nouvelle = true;
	const fermer = charger(e);
	assert.equal(fermer(), true);
	assert.deepEqual(e.clics, ["k:close"]);
});

test("thread-slot : le bouton de retour est marque leave-thread (cible du raccourci, meme masque sur ordinateur)", () => {
	const t = code("components/mailbox/default/thread-slot.tsx");
	assert.match(t, /data-ss2i-shortcut="leave-thread"[\s\S]*?onClick=\{\(\) => leaveThreadToList\(router, pathname \?\? ""\)\}/);
	// Le bouton est md:hidden : le script ne doit pas le filtrer par visible().
	assert.doesNotMatch(sh, /leave-thread"\]'\)\)\.(find|filter)\(visible\)/);
});

test("catalogue : Echap n'est plus reserve a la nouvelle interface", () => {
	const c = code("components/k/shortcuts-catalog.ts");
	const l = c.split("\n").find((x) => /id: "close"/.test(x));
	assert.ok(l);
	assert.doesNotMatch(l!, /outlookOnly/);
});

if (failed) {
	console.error(`${failed} echec(s)`);
	process.exit(1);
}
console.log("tous les tests passent");
