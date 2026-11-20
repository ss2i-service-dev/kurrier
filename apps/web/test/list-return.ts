// Retour a la liste apres la lecture d'un mail, interface classique. Samuel le 05/11/2026 :
// « je reviens dans la liste de mes mails et [...] la liste a scrolle, je suis perdu dans
// l'historique » ; et un repere sur le dernier mail consulte, ou le precedent s'il a ete archive.
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
//   1) logique (lib/list-return.ts) : chemin de la liste, historique, dernier fil encore affiche ;
//   2) cablage : toute liste classique masquee quand un fil est ouvert (className
//      onThread ? (pane ? "invisible" : "hidden"), 20/11) pose la ref de useListReturn et passe lastViewed a ses lignes.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/list-return.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listPathOf, noteListLeft, pickLastViewed, pushViewed, takeListReturn, threadIdOf } from "../lib/list-return";

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

const inbox = "/en/w/abc/dashboard/mail/id1/inbox";

test("chemin de la liste et fil ouvert tires de l'URL", () => {
	assert.equal(listPathOf(`${inbox}/threads/t42`), inbox);
	assert.equal(listPathOf(`${inbox}/threads/t42/`), inbox);
	assert.equal(listPathOf(inbox), inbox);
	assert.equal(listPathOf(`${inbox}/search/threads/t1`), `${inbox}/search`);
	assert.equal(threadIdOf(`${inbox}/threads/t42`), "t42");
	assert.equal(threadIdOf(inbox), null);
});

test("historique : plus recent en dernier, sans doublon, borne", () => {
	let h: string[] = [];
	h = pushViewed(h, "a");
	h = pushViewed(h, "b");
	h = pushViewed(h, "a");
	assert.deepEqual(h, ["b", "a"]);
	let long: string[] = [];
	for (let i = 0; i < 60; i++) long = pushViewed(long, `t${i}`, 50);
	assert.equal(long.length, 50);
	assert.equal(long[49], "t59");
});

test("repere : dernier fil consulte, sinon le precedent s'il a quitte la liste", () => {
	const h = ["a", "b", "c"];
	assert.equal(pickLastViewed(h, ["a", "b", "c", "d"]), "c");
	// c archive : il n'est plus affiche, le repere passe sur b
	assert.equal(pickLastViewed(h, ["a", "b", "d"]), "b");
	assert.equal(pickLastViewed(h, ["d"]), null);
	assert.equal(pickLastViewed([], ["a"]), null);
});

// Samuel le 19/11/2026 : sur mobile, apres avoir defile dans un mail et l'avoir ferme, la
// liste etait defilee. En largeur mobile la liste est demontee pendant le fil : au retour,
// le hook remonte sans memoire et ne retablissait rien.
test("liste demontee par le fil : sa position revient au remontage, une seule fois", () => {
	noteListLeft(inbox);
	assert.equal(takeListReturn(`${inbox}/search`), false, "une autre liste ne reprend rien");
	assert.equal(takeListReturn(inbox), false, "la marque est effacee par l'autre liste");
	noteListLeft(inbox);
	assert.equal(takeListReturn(inbox), true);
	assert.equal(takeListReturn(inbox), false, "une seule fois");
});

test("cablage lib/list-return.ts : marque au demontage, reprise au remontage", () => {
	const src = readFileSync(join(__dirname, "../lib/list-return.ts"), "utf8");
	assert.match(src, /noteListLeft\(keyRef\.current\)/);
	assert.match(src, /before === undefined && takeListReturn\(listKey\)/);
});

const dir = join(__dirname, "../components/mailbox/default");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
	const src = readFileSync(join(dir, f), "utf8");
	if (!/className=\{onThread \? \(pane \? "invisible" : "hidden"\)/.test(src) || !/<WebmailListItem/.test(src)) continue;
	test(`cablage ${f} : useListReturn, ref sur la liste, lastViewed sur les lignes`, () => {
		assert.match(src, /useListReturn\(/);
		assert.match(src, /ref=\{listRef\} className=\{onThread \? \(pane \? "invisible" : "hidden"\)/);
		const rows = (src.match(/<WebmailListItem(Mobile)?\b/g) ?? []).length;
		const marked = (src.match(/lastViewed=\{/g) ?? []).length;
		assert.ok(rows > 0, "aucune ligne de fil trouvee");
		assert.equal(marked, rows, `${rows} lignes, ${marked} avec lastViewed`);
	});
}

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
