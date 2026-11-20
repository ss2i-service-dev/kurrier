// Ctrl+A dans une liste de mails coche tous les mails de la vue (Samuel le 20/11/2026), dans
// les deux interfaces, sans jamais voler Ctrl+A a un champ de saisie ni a un mail en cours
// d'ecriture (verrou de saisie, patches 0110 et 0111).
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

test("catalogue : entree selectAll, groupe Organisation, defaut Ctrl+a", () => {
	const c = code("components/k/shortcuts-catalog.ts");
	assert.match(c, /\|\s*"selectAll"/, "ShortcutId selectAll");
	assert.match(c, /\{ id: "selectAll", group: "organize", en: "Select all[^}]*fr: "Tout sélectionner[^}]*defaults: \["Ctrl\+a"\]/);
});

test("script : Ctrl+a dans la table, action toutSelectionner()", () => {
	const sh = code("public/ss2i-shortcuts.js");
	assert.match(sh, /\["selectAll", \["Ctrl\+a"\], [^\n]*toutSelectionner\(\)\]/);
});

test("script : la case marquee de la liste visible, jamais dans une saisie, un composeur, un menu ou une fenetre", () => {
	const sh = code("public/ss2i-shortcuts.js");
	const m = sh.match(/const toutSelectionner = \(\) => \{([\s\S]*?)\n  \};/);
	assert.ok(m, "fonction toutSelectionner");
	const f = m![1];
	assert.match(f, /dansUneSaisie\(document\.activeElement\)/, "Ctrl+A natif dans un champ");
	assert.match(f, /composeurOuvert\(\)/, "Ctrl+A natif pendant la redaction");
	assert.match(f, /\[role="menu"\][^\n]*\[role="dialog"\]/, "rien dans un menu ou une fenetre");
	assert.match(f, /input\[data-ss2i-shortcut="select-all"\]/, "case marquee");
	assert.match(f, /\.find\(visible\)/, "case visible seulement");
	assert.match(f, /!cible\.checked/, "deja tout coche : on ne decoche pas");
	assert.match(f, /return true/, "frappe consommee sur une liste");
	assert.match(f, /return false/, "sinon Ctrl+A natif");
});

test("les deux en-tetes de liste marquent leur case « tout selectionner »", () => {
	for (const p of ["components/mailbox/default/mail-list-header.tsx", "components/k/list-header.tsx"]) {
		const c = code(p);
		const i = c.search(/aria-label="(Select all|Tout sélectionner)"/);
		assert.ok(i > 0, `${p} : case`);
		const autour = c.slice(i - 200, i + 300);
		assert.match(autour, /data-ss2i-shortcut="select-all"/, `${p} : marque`);
	}
});

if (failed) {
	console.error(`${failed} test(s) en echec`);
	process.exit(1);
}
