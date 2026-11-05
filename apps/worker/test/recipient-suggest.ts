// Ranking of recipient suggestions (packages/common/src/recipient-suggest.ts): frecency,
// association with the recipients already entered, text filter, exclusions.
// No database. Run (from the repository root):
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

// Scores "brought to now" as the server provides them.
const candidates: RecipientCandidate[] = [
	{ email: "dev@acme-labs.com", name: null, score: 40, lastUsedAt: daysAgo(0.5) },
	{ email: "dana@client-a.example", name: "Dana Martin", score: 6, lastUsedAt: daysAgo(10) },
	{ email: "jack@acme.com", name: "Jack", score: 15, lastUsedAt: daysAgo(1) },
	{ email: "hugh@acme.com", name: "Hugh", score: 12, lastUsedAt: daysAgo(2) },
	{ email: "x@client-x.example", name: "Client X", score: 3, lastUsedAt: daysAgo(20) },
	{ email: "accounting@client-x.example", name: "Accounting X", score: 1, lastUsedAt: daysAgo(90) },
	{ email: "new@prospect.example", name: "New Lead", score: 0.9, lastUsedAt: daysAgo(1) },
	{ email: "z@old.example", name: "Zed", score: 0.01, lastUsedAt: daysAgo(500) },
	// address book only, never written to
	{ email: "dunn@directory.example", name: "Jane Dunn", score: 0, lastUsedAt: null, id: "c1" },
	{ email: "dave@directory.example", name: "Dave", score: 0, lastUsedAt: null, id: "c2" },
];
const emails = (r: { email: string }[]) => r.map((x) => x.email);

test("a single letter: dev@ comes first among the d", () => {
	const r = rankRecipientSuggestions({ query: "d", current: [], candidates, now });
	assert.deepEqual(emails(r), [
		"dev@acme-labs.com",
		"dana@client-a.example",
		"dave@directory.example",
		"dunn@directory.example",
	]);
});

test("empty field: best candidates by frecency, address-book-only at the tail", () => {
	const r = rankRecipientSuggestions({ query: "", current: [], candidates, now, limit: 5 });
	assert.deepEqual(emails(r), [
		"dev@acme-labs.com",
		"jack@acme.com",
		"hugh@acme.com",
		"dana@client-a.example",
		"x@client-x.example",
	]);
	const all = rankRecipientSuggestions({ query: "", current: [], candidates, now, limit: 50 });
	assert.deepEqual(emails(all).slice(-2).sort(), ["dave@directory.example", "dunn@directory.example"]);
});

test("association: client X entered -> dev@ then accounting X ahead of the colleagues", () => {
	const pairs: RecipientPair[] = [
		{ email: "x@client-x.example", other: "dev@acme-labs.com", score: 3 },
		{ email: "x@client-x.example", other: "accounting@client-x.example", score: 2.5 },
		{ email: "x@client-x.example", other: "hugh@acme.com", score: 0.2 },
		// pair of a recipient not entered: ignored
		{ email: "dana@client-a.example", other: "z@old.example", score: 50 },
	];
	const r = rankRecipientSuggestions({
		query: "",
		current: ["X@Client-X.example"],
		candidates,
		pairs,
		now,
		limit: 4,
	});
	assert.deepEqual(emails(r), [
		"dev@acme-labs.com",
		"jack@acme.com",
		"hugh@acme.com",
		"accounting@client-x.example",
	]);
	// accounting@ (frecency ~1 + 4 * 2.5 = 11) goes ahead of dana (6 + bonus 0.2)
	const compta = r.find((x) => x.email === "accounting@client-x.example")!;
	const didier = rankRecipientSuggestions({ query: "dana", current: ["x@client-x.example"], candidates, pairs, now })[0];
	assert.ok(compta.total > didier.total);
	assert.ok(Math.abs(compta.total - (frecency(candidates[5], now) + ASSOC_WEIGHT * 2.5)) < 1e-9);
});

test("association accumulated over several fields (To + Cc)", () => {
	const pairs: RecipientPair[] = [
		{ email: "x@client-x.example", other: "accounting@client-x.example", score: 6 },
		{ email: "dana@client-a.example", other: "accounting@client-x.example", score: 6 },
	];
	const r = rankRecipientSuggestions({
		query: "",
		current: ["x@client-x.example", "dana@client-a.example"],
		candidates,
		pairs,
		now,
		limit: 1,
	});
	assert.equal(r[0].email, "accounting@client-x.example");
	assert.ok(Math.abs(r[0].total - (frecency(candidates[5], now) + ASSOC_WEIGHT * 12)) < 1e-9);
});

test("exclusions: addresses already entered (case ignored) and the user's identities", () => {
	const r = rankRecipientSuggestions({
		query: "",
		current: ["DEV@acme-labs.com"],
		own: ["jack@acme.com"],
		candidates,
		now,
		limit: 50,
	});
	assert.ok(!emails(r).includes("dev@acme-labs.com"));
	assert.ok(!emails(r).includes("jack@acme.com"));
});

test("recency: an address written to yesterday with a single send goes ahead of an old regular", () => {
	const r = rankRecipientSuggestions({ query: "", current: [], candidates, now, limit: 50 });
	const pos = (e: string) => emails(r).indexOf(e);
	assert.ok(pos("new@prospect.example") < pos("accounting@client-x.example"));
	assert.ok(pos("new@prospect.example") < pos("z@old.example"));
	assert.ok(Math.abs(frecency({ email: "a", score: 1, lastUsedAt: now }, now) - (1 + RECENT_BONUS)) < 1e-9);
	assert.equal(frecency({ email: "a", score: 0, lastUsedAt: null }, now), 0);
});

test("text filter: prefix of the address, of the name, of a word of the name, of an address segment", () => {
	assert.equal(textMatch("dev", "dev@acme-labs.com", null), 4);
	assert.equal(textMatch("dev@", "dev@acme-labs.com", null), 4);
	assert.equal(textMatch("Dana M", "dana@client-a.example", "Dana Martin"), 3);
	assert.equal(textMatch("martin", "dana@client-a.example", "Dana Martin"), 2);
	assert.equal(textMatch("acme", "dev@acme-labs.com", null), 1);
	assert.equal(textMatch("labs", "dev@acme-labs.com", null), 1);
	assert.equal(textMatch("client-x", "x@client-x.example", "Client X"), 1);
	assert.equal(textMatch("ev", "dev@acme-labs.com", null), 0);
	assert.equal(textMatch("", "dev@acme-labs.com", null), 4);
	const r = rankRecipientSuggestions({ query: "acme", current: [], candidates, now, limit: 50 });
	assert.deepEqual(emails(r), ["dev@acme-labs.com", "jack@acme.com", "hugh@acme.com"]);
});

test("text tie-break at equal score: address before name before segment", () => {
	const tie: RecipientCandidate[] = [
		{ email: "zz@mail.example", name: "Marc Al", score: 1, lastUsedAt: daysAgo(5) },
		{ email: "al@mail.example", name: "Zoe", score: 1, lastUsedAt: daysAgo(5) },
		{ email: "yy@al-group.example", name: "Yann", score: 1, lastUsedAt: daysAgo(5) },
		{ email: "aa@mail.example", name: "Alice", score: 1, lastUsedAt: daysAgo(5) },
	];
	const r = rankRecipientSuggestions({ query: "al", current: [], candidates: tie, now });
	assert.deepEqual(emails(r), ["al@mail.example", "aa@mail.example", "zz@mail.example", "yy@al-group.example"]);
});

test("duplicate statistics + address book: a single row, name and avatar filled in", () => {
	const r = rankRecipientSuggestions({
		query: "dev",
		current: [],
		candidates: [
			{ email: "dev@acme-labs.com", name: "", score: 40, lastUsedAt: daysAgo(1) },
			{ email: "Dev@ACME-labs.com", name: "Dev team", score: 0, id: "c9", avatar: "http://a" },
		],
		now,
	});
	assert.equal(r.length, 1);
	assert.equal(r[0].name, "Dev team");
	assert.equal(r[0].id, "c9");
	assert.equal(r[0].avatar, "http://a");
	assert.equal(r[0].score, 40);
});

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("recipient-suggest: ok");
