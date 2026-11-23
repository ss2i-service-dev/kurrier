// Dans un mail ouvert, « a » archive et « e » supprime meme quand le dernier message du fil est une
// reponse qui vient de partir et attend encore en Boite d'envoi (Samuel le 23/11/2026 : « quand je
// suis dans un mail ouvert, je peux pas l'archiver, que ce soit A ou Shift A »). La rangee du bas
// (Reply, Forward, Archive, Delete) n'est rendue que sous le dernier message, et pas pendant que son
// editeur est ouvert : avec un brouillon en attente d'envoi en dernier, elle n'existe plus et le
// raccourci, qui cherchait le bouton par son texte « Archive », ne trouvait rien. Il vise desormais
// le bouton de la barre de chaque message, marque data-ss2i-shortcut.
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

test("barre du message : boutons Archive et Delete marques open-archive / open-delete", () => {
	const r = code("components/mailbox/default/email-renderer.tsx");
	assert.match(r, /aria-label="Archive"[^>]*data-ss2i-shortcut="open-archive"|data-ss2i-shortcut="open-archive"[^>]*aria-label="Archive"/);
	assert.match(r, /aria-label="Delete"[^>]*data-ss2i-shortcut="open-delete"|data-ss2i-shortcut="open-delete"[^>]*aria-label="Delete"/);
});

test("script : dans un mail, le bouton marque de la barre d'abord, visible et hors inert", () => {
	const sh = code("public/ss2i-shortcuts.js");
	const m = sh.match(/const surMailOuSelection = \(libelle\) => \{([\s\S]*?)\n  \};/);
	assert.ok(m, "fonction surMailOuSelection");
	const f = m![1];
	assert.match(f, /dansUnMail\(\)/);
	assert.match(f, /open-delete/);
	assert.match(f, /open-archive/);
	assert.match(f, /barreDuMessageLu\(/, "bouton visible, jamais celui de la liste inert");
	assert.ok(f.indexOf("open-") < f.indexOf("cliquer(libelle)"), "le bouton marque avant la recherche par texte");
});

// Samuel le 23/11/2026 : « le menu contextuel s'ouvre tout en haut du scroll et pas la ou on se
// trouve ». Maj+A cliquait le premier bouton « Archiver pour... » du fil, celui du premier message,
// hors de vue dans un fil long. Le raccourci vise la barre du message en cours de lecture.
const raw = readFileSync(join(WEB, "public/ss2i-shortcuts.js"), "utf8");
const src = raw.match(/const choisirBarreLue = (\([^)]*\) => \{[\s\S]*?\n  \});/);
test("choisirBarreLue existe dans le script", () => assert.ok(src, "fonction choisirBarreLue"));
const choisir: (tops: number[], haut: number, bas: number) => number = src
	? new Function(`return ${src[1]}`)()
	: () => 0;

test("la barre visible la plus haute, pas celle du premier message", () => {
	// 5 messages, barres a -2650, -1700, 433, 1300, 2200 ; ecran de 74 a 894.
	assert.equal(choisir([-2650, -1700, 433, 1300, 2200], 74, 894), 2);
});
test("aucune barre a l'ecran : celle du message dont on lit le corps (la derniere au-dessus)", () => {
	assert.equal(choisir([-2650, -1700, 1300], 74, 894), 1);
});
test("barre sous la barre du haut collante : comptee au-dessus, pas visible", () => {
	assert.equal(choisir([-500, 40, 1300], 74, 894), 1);
});
test("fil d'un seul message, ou tout en bas : la seule ou la premiere", () => {
	assert.equal(choisir([169], 74, 894), 0);
	assert.equal(choisir([1000, 2000], 74, 894), 0);
	assert.equal(choisir([], 74, 894), -1);
});
test("script : Maj+A et a / e passent par la barre du message lu", () => {
	const sh = code("public/ss2i-shortcuts.js");
	const ap = sh.match(/const archiverPour = \(\) => \{([\s\S]*?)\n  \};/);
	assert.ok(ap, "fonction archiverPour");
	assert.match(ap![1], /barreDuMessageLu\(/);
	const sm = sh.match(/const surMailOuSelection = \(libelle\) => \{([\s\S]*?)\n  \};/);
	assert.match(sm![1], /barreDuMessageLu\(/);
});

if (failed) {
	console.error(`${failed} test(s) en echec`);
	process.exit(1);
}
