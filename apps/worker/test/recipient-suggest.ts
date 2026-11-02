// Classement des suggestions de destinataires (packages/common/src/recipient-suggest.ts) :
// frecency, association avec les destinataires deja saisis, filtre textuel, exclusions.
// Aucune base. Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/recipient-suggest.ts
import assert from "node:assert/strict";
import {
	ASSOC_WEIGHT,
	RECENT_BONUS,
	frecency,
	rankRecipientSuggestions,
	textMatch,
	type RecipientCandidate,
	type RecipientPair,
} from "../../../packages/common/src/recipient-suggest";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const now = new Date("2026-11-02T09:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

// Scores « ramenes a maintenant » tels que le serveur les fournit.
const candidates: RecipientCandidate[] = [
	{ email: "dev@ss2i-digital.fr", name: null, score: 40, lastUsedAt: daysAgo(0.5) },
	{ email: "didier@client-a.fr", name: "Didier Martin", score: 6, lastUsedAt: daysAgo(10) },
	{ email: "jb@ss2i.fr", name: "JB", score: 15, lastUsedAt: daysAgo(1) },
	{ email: "hugo@ss2i.fr", name: "Hugo", score: 12, lastUsedAt: daysAgo(2) },
	{ email: "x@client-x.fr", name: "Client X", score: 3, lastUsedAt: daysAgo(20) },
	{ email: "compta@client-x.fr", name: "Compta X", score: 1, lastUsedAt: daysAgo(90) },
	{ email: "new@prospect.fr", name: "Nouveau", score: 0.9, lastUsedAt: daysAgo(1) },
	{ email: "z@old.fr", name: "Zed", score: 0.01, lastUsedAt: daysAgo(500) },
	// carnet seul, jamais ecrit
	{ email: "dupont@annuaire.fr", name: "Jean Dupont", score: 0, lastUsedAt: null, id: "c1" },
	{ email: "daniel@annuaire.fr", name: "Daniel", score: 0, lastUsedAt: null, id: "c2" },
];
const emails = (r: { email: string }[]) => r.map((x) => x.email);

test("une seule lettre : dev@ sort en tete des d", () => {
	const r = rankRecipientSuggestions({ query: "d", current: [], candidates, now });
	assert.deepEqual(emails(r), [
		"dev@ss2i-digital.fr",
		"didier@client-a.fr",
		"daniel@annuaire.fr",
		"dupont@annuaire.fr",
	]);
});

test("champ vide : meilleurs candidats par frecency, carnet seul en queue", () => {
	const r = rankRecipientSuggestions({ query: "", current: [], candidates, now, limit: 5 });
	assert.deepEqual(emails(r), [
		"dev@ss2i-digital.fr",
		"jb@ss2i.fr",
		"hugo@ss2i.fr",
		"didier@client-a.fr",
		"x@client-x.fr",
	]);
	const all = rankRecipientSuggestions({ query: "", current: [], candidates, now, limit: 50 });
	assert.deepEqual(emails(all).slice(-2).sort(), ["daniel@annuaire.fr", "dupont@annuaire.fr"]);
});

test("association : client X saisi -> dev@ puis compta X avant les colleagues", () => {
	const pairs: RecipientPair[] = [
		{ email: "x@client-x.fr", other: "dev@ss2i-digital.fr", score: 3 },
		{ email: "x@client-x.fr", other: "compta@client-x.fr", score: 2.5 },
		{ email: "x@client-x.fr", other: "hugo@ss2i.fr", score: 0.2 },
		// paire d'un destinataire non saisi : ignoree
		{ email: "didier@client-a.fr", other: "z@old.fr", score: 50 },
	];
	const r = rankRecipientSuggestions({
		query: "",
		current: ["X@Client-X.fr"],
		candidates,
		pairs,
		now,
		limit: 4,
	});
	assert.deepEqual(emails(r), [
		"dev@ss2i-digital.fr",
		"jb@ss2i.fr",
		"hugo@ss2i.fr",
		"compta@client-x.fr",
	]);
	// compta@ (frecency ~1 + 4 * 2.5 = 11) passe devant didier (6 + bonus 0.2)
	const compta = r.find((x) => x.email === "compta@client-x.fr")!;
	const didier = rankRecipientSuggestions({ query: "didier", current: ["x@client-x.fr"], candidates, pairs, now })[0];
	assert.ok(compta.total > didier.total);
	assert.ok(Math.abs(compta.total - (frecency(candidates[5], now) + ASSOC_WEIGHT * 2.5)) < 1e-9);
});

test("association cumulee sur plusieurs champs (To + Cc)", () => {
	const pairs: RecipientPair[] = [
		{ email: "x@client-x.fr", other: "compta@client-x.fr", score: 6 },
		{ email: "didier@client-a.fr", other: "compta@client-x.fr", score: 6 },
	];
	const r = rankRecipientSuggestions({
		query: "",
		current: ["x@client-x.fr", "didier@client-a.fr"],
		candidates,
		pairs,
		now,
		limit: 1,
	});
	assert.equal(r[0].email, "compta@client-x.fr");
	assert.ok(Math.abs(r[0].total - (frecency(candidates[5], now) + ASSOC_WEIGHT * 12)) < 1e-9);
});

test("exclusions : adresses deja saisies (casse ignoree) et identites de l'utilisateur", () => {
	const r = rankRecipientSuggestions({
		query: "",
		current: ["DEV@ss2i-digital.fr"],
		own: ["jb@ss2i.fr"],
		candidates,
		now,
		limit: 50,
	});
	assert.ok(!emails(r).includes("dev@ss2i-digital.fr"));
	assert.ok(!emails(r).includes("jb@ss2i.fr"));
});

test("recence : une adresse ecrite hier avec un seul envoi passe devant un vieux regulier", () => {
	const r = rankRecipientSuggestions({ query: "", current: [], candidates, now, limit: 50 });
	const pos = (e: string) => emails(r).indexOf(e);
	assert.ok(pos("new@prospect.fr") < pos("compta@client-x.fr"));
	assert.ok(pos("new@prospect.fr") < pos("z@old.fr"));
	assert.ok(Math.abs(frecency({ email: "a", score: 1, lastUsedAt: now }, now) - (1 + RECENT_BONUS)) < 1e-9);
	assert.equal(frecency({ email: "a", score: 0, lastUsedAt: null }, now), 0);
});

test("filtre textuel : prefixe de l'adresse, du nom, d'un mot du nom, d'un segment de l'adresse", () => {
	assert.equal(textMatch("dev", "dev@ss2i-digital.fr", null), 4);
	assert.equal(textMatch("dev@", "dev@ss2i-digital.fr", null), 4);
	assert.equal(textMatch("Didier M", "didier@client-a.fr", "Didier Martin"), 3);
	assert.equal(textMatch("martin", "didier@client-a.fr", "Didier Martin"), 2);
	assert.equal(textMatch("ss2i", "dev@ss2i-digital.fr", null), 1);
	assert.equal(textMatch("digital", "dev@ss2i-digital.fr", null), 1);
	assert.equal(textMatch("client-x", "x@client-x.fr", "Client X"), 1);
	assert.equal(textMatch("ev", "dev@ss2i-digital.fr", null), 0);
	assert.equal(textMatch("", "dev@ss2i-digital.fr", null), 4);
	const r = rankRecipientSuggestions({ query: "ss2i", current: [], candidates, now, limit: 50 });
	assert.deepEqual(emails(r), ["dev@ss2i-digital.fr", "jb@ss2i.fr", "hugo@ss2i.fr"]);
});

test("departage textuel a score egal : adresse avant nom avant segment", () => {
	const tie: RecipientCandidate[] = [
		{ email: "zz@mail.fr", name: "Marc Al", score: 1, lastUsedAt: daysAgo(5) },
		{ email: "al@mail.fr", name: "Zoe", score: 1, lastUsedAt: daysAgo(5) },
		{ email: "yy@al-group.fr", name: "Yann", score: 1, lastUsedAt: daysAgo(5) },
		{ email: "aa@mail.fr", name: "Alice", score: 1, lastUsedAt: daysAgo(5) },
	];
	const r = rankRecipientSuggestions({ query: "al", current: [], candidates: tie, now });
	assert.deepEqual(emails(r), ["al@mail.fr", "aa@mail.fr", "zz@mail.fr", "yy@al-group.fr"]);
});

test("doublon statistiques + carnet : une seule ligne, nom et avatar completes", () => {
	const r = rankRecipientSuggestions({
		query: "dev",
		current: [],
		candidates: [
			{ email: "dev@ss2i-digital.fr", name: "", score: 40, lastUsedAt: daysAgo(1) },
			{ email: "Dev@SS2I-digital.fr", name: "Equipe dev", score: 0, id: "c9", avatar: "http://a" },
		],
		now,
	});
	assert.equal(r.length, 1);
	assert.equal(r[0].name, "Equipe dev");
	assert.equal(r[0].id, "c9");
	assert.equal(r[0].avatar, "http://a");
	assert.equal(r[0].score, 40);
});

if (failures) {
	console.error(`${failures} echec(s)`);
	process.exit(1);
}
console.log("recipient-suggest : ok");
