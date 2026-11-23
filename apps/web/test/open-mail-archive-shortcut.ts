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
	assert.match(f, /\.find\(visible\)/, "bouton visible, jamais celui de la liste inert");
	assert.ok(f.indexOf("open-") < f.indexOf("cliquer(libelle)"), "le bouton marque avant la recherche par texte");
});

if (failed) {
	console.error(`${failed} test(s) en echec`);
	process.exit(1);
}
