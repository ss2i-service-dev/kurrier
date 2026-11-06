// Interface classique : les fleches de pagination sous la liste ne faisaient rien
// (Samuel le 06/11 : « soit il n'y a pas de page suivante et auquel cas il faut griser la
// petite fleche page suivante, ou alors [...] il faudrait que la petite fleche fonctionne »).
// Cause : total = count / 50, non arrondi (2 fils -> 0,04 page : fleche suivante active,
// clic vers une page < 1 ignore), et count comptait les messages du dossier, pas les fils
// listes (dernieres pages vides sur un gros dossier). Le nombre de pages vient de
// pageCount(), sur le nombre de fils visibles (meme filtre de mise en attente que la liste).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/mail-pagination.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageCount, clampPage } from "../lib/mail-pagination";

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

test("nombre de pages entier, au moins une", () => {
	assert.equal(pageCount(0, 50), 1);
	assert.equal(pageCount(2, 50), 1);
	assert.equal(pageCount(50, 50), 1);
	assert.equal(pageCount(51, 50), 2);
	assert.equal(pageCount(1234, 50), 25);
	assert.equal(pageCount(Number.NaN, 50), 1);
});

test("page ramenee entre 1 et la derniere", () => {
	assert.equal(clampPage(0, 3), 1);
	assert.equal(clampPage(Number.NaN, 3), 1);
	assert.equal(clampPage(2, 3), 2);
	assert.equal(clampPage(9, 3), 3);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("la pagination classique utilise pageCount, plus count / 50", () => {
	const src = read("components/mailbox/default/mail-pagination.tsx");
	assert.ok(src.includes("pageCount("), "mail-pagination.tsx doit appeler pageCount");
	assert.ok(!/count\s*\/\s*50/.test(src), "plus de count / 50");
});

test("count de fetchMailbox compte les fils visibles, pas les messages", () => {
	const src = read("lib/actions/mailbox.ts");
	const start = src.indexOf("export const fetchMailbox = cache(");
	assert.ok(start >= 0, "fetchMailbox introuvable");
	const body = src.slice(start, src.indexOf("export type FetchMailboxResult", start));
	assert.ok(body.includes(".from(mailboxThreads)"), "le compte doit porter sur mailboxThreads");
	assert.ok(body.includes("snoozedUntil"), "meme filtre de mise en attente que fetchMailboxThreads");
	assert.ok(!/\.from\(messages\)/.test(body), "plus de compte sur messages");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
