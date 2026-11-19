// Archiver avec une duree de vie (Samuel le 19/11/2026) : partie pure de l'echeance (presets,
// controle de la date recue, affichage JJ/MM/AAAA, tranche horaire du jobId du tick). Date seule :
// l'echeance est le debut du jour choisi, fuseau du navigateur, aucune heure saisie. Plan :
// docs/plans/archive-duree-de-vie.md. Aucune base, aucun reseau. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/thread-expiry.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPIRY_PRESETS, expiryBucket, expiryFromPreset, formatExpiry, parseExpiry } from "../../../packages/common/src/thread-expiry";

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

const ROOT = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

// 19/11/2026 10:30 en heure locale : les attendus sont construits en local, comme la fonction.
const NOW = new Date(2026, 10, 19, 10, 30, 0);

test("presets : libelles et nombre de mois", () => {
	assert.deepEqual(
		EXPIRY_PRESETS.map((p) => [p.id, p.months, p.label]),
		[
			["1m", 1, "1 mois"],
			["3m", 3, "3 mois"],
			["6m", 6, "6 mois"],
			["1y", 12, "1 an"],
			["2y", 24, "2 ans"],
		],
	);
});

test("expiryFromPreset : debut du jour local a +1, +3, +6, +12, +24 mois", () => {
	assert.equal(expiryFromPreset("1m", NOW).getTime(), new Date(2026, 11, 19).getTime());
	assert.equal(expiryFromPreset("3m", NOW).getTime(), new Date(2027, 1, 19).getTime());
	assert.equal(expiryFromPreset("6m", NOW).getTime(), new Date(2027, 4, 19).getTime());
	assert.equal(expiryFromPreset("1y", NOW).getTime(), new Date(2027, 10, 19).getTime());
	assert.equal(expiryFromPreset("2y", NOW).getTime(), new Date(2028, 10, 19).getTime());
});

test("expiryFromPreset : fin de mois ramenee au dernier jour du mois d'arrivee", () => {
	assert.equal(expiryFromPreset("1m", new Date(2026, 0, 31, 23, 59)).getTime(), new Date(2026, 1, 28).getTime());
	assert.equal(expiryFromPreset("1y", new Date(2028, 1, 29, 8, 0)).getTime(), new Date(2029, 1, 28).getTime());
});

test("parseExpiry : une date future a moins de 10 ans est rendue telle quelle", () => {
	const iso = new Date(2026, 11, 19).toISOString();
	const d = parseExpiry(iso, NOW);
	assert.ok(d instanceof Date);
	assert.equal(d!.toISOString(), iso);
});

test("parseExpiry : vide, invalide, passee ou lointaine vaut null", () => {
	assert.equal(parseExpiry("", NOW), null);
	assert.equal(parseExpiry("   ", NOW), null);
	assert.equal(parseExpiry(null, NOW), null);
	assert.equal(parseExpiry(undefined, NOW), null);
	assert.equal(parseExpiry("pas une date", NOW), null);
	assert.equal(parseExpiry(new Date(2026, 10, 18).toISOString(), NOW), null);
	assert.equal(parseExpiry(NOW.toISOString(), NOW), null, "strictement apres now");
	assert.equal(parseExpiry(new Date(2099, 0, 1).toISOString(), NOW), null);
	assert.equal(parseExpiry(new Date(2036, 10, 19, 10, 30).toISOString(), NOW), null, "10 ans pile exclus");
	assert.ok(parseExpiry(new Date(2036, 10, 19, 10, 29).toISOString(), NOW));
});

test("formatExpiry : JJ/MM/AAAA, zeros de tete", () => {
	assert.equal(formatExpiry(new Date(2026, 11, 19)), "19/12/2026");
	assert.equal(formatExpiry(new Date(2027, 0, 5)), "05/01/2027");
});

test("expiryBucket : AAAAMMJJHH en UTC, change d'heure en heure", () => {
	assert.equal(expiryBucket(new Date("2026-11-19T10:30:00Z")), "2026111910");
	assert.equal(expiryBucket(new Date("2026-11-19T10:59:59Z")), "2026111910");
	assert.equal(expiryBucket(new Date("2026-11-19T11:00:00Z")), "2026111911");
	assert.equal(expiryBucket(new Date("2027-01-02T03:04:05Z")), "2027010203");
});

test("index de @common : thread-expiry exporte", () => {
	assert.match(src("packages/common/src/index.ts"), /export \* from "\.\/thread-expiry";/);
});

// db/ n'est pas dans le contexte de construction de l'image : controle de la migration seulement
// dans le depot.
const migPath = "db/init/migrations/ss2i_011_migration.sql";
let mig: string | null = null;
try {
	mig = src(migPath).replace(/--[^\n]*/g, "");
} catch {
	console.log(`skip  migration ss2i_011 (db/ absent)`);
}
if (mig !== null) {
	test("migration ss2i_011 : colonne, index partiel, trigger etoile, rejouable", () => {
		assert.match(mig!, /ADD COLUMN IF NOT EXISTS expires_at timestamptz/i);
		assert.match(mig!, /CREATE INDEX IF NOT EXISTS ix_mbth_expires_at\b[\s\S]*WHERE expires_at IS NOT NULL/i);
		assert.match(mig!, /CREATE OR REPLACE FUNCTION public\.ss2i_mbth_expiry_guard/i);
		assert.match(mig!, /DROP TRIGGER IF EXISTS ss2i_mbth_expiry_guard/i);
		assert.match(mig!, /WHEN \(NEW\.starred AND NEW\.expires_at IS NOT NULL\)/i);
	});
	test("migration ss2i_011 : lock_timeout de 5 s, premiere instruction", () => {
		assert.ok(mig!.trim().startsWith("SET lock_timeout = '5s';"), "SET lock_timeout = '5s'; en tete");
	});
}

test("schema drizzle : expiresAt et index partiel sur mailbox_threads", () => {
	const s = src("packages/db/src/drizzle/schema.ts");
	assert.match(s, /expiresAt: timestamp\("expires_at", \{ withTimezone: true \}\)/);
	assert.match(s, /index\("ix_mbth_expires_at"\)\s*\.on\(t\.expiresAt\)\s*\.where\(sql`\$\{t\.expiresAt\} is not null`\)/);
});

if (failed) {
	console.error(`\n${failed} test(s) en echec`);
	process.exit(1);
}
console.log("\nthread-expiry : tout est vert");
