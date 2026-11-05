// Retour a la liste apres la lecture d'un mail, interface classique. Samuel le 05/11/2026 :
// « je reviens dans la liste de mes mails et [...] la liste a scrolle, je suis perdu dans
// l'historique » ; et un repere sur le dernier mail consulte, ou le precedent s'il a ete archive.
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
//   1) logique (lib/list-return.ts) : chemin de la liste, historique, dernier fil encore affiche ;
//   2) cablage : toute liste classique masquee quand un fil est ouvert (className
//      onThread ? "hidden") pose la ref de useListReturn et passe lastViewed a ses lignes.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/list-return.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listPathOf, pickLastViewed, pushViewed, threadIdOf } from "../lib/list-return";

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

const dir = join(__dirname, "../components/mailbox/default");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
	const src = readFileSync(join(dir, f), "utf8");
	if (!/className=\{onThread \? "hidden"/.test(src) || !/<WebmailListItem/.test(src)) continue;
	test(`cablage ${f} : useListReturn, ref sur la liste, lastViewed sur les lignes`, () => {
		assert.match(src, /useListReturn\(/);
		assert.match(src, /ref=\{listRef\} className=\{onThread \? "hidden"/);
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
