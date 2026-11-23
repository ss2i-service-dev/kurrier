// Archive for a chosen duration: pure part of the expiry (presets, check of the received date,
// display, hour bucket of the tick's jobId). Date only: the expiry is the start of the chosen
// day, browser time zone, no time typed. No database, no network. From the root:
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

// Nov 19 2026 10:30 local time: expected values are built locally, like the function.
const NOW = new Date(2026, 10, 19, 10, 30, 0);

test("presets: labels and number of months", () => {
	assert.deepEqual(
		EXPIRY_PRESETS.map((p) => [p.id, p.months, p.label]),
		[
			["1m", 1, "1 month"],
			["3m", 3, "3 months"],
			["6m", 6, "6 months"],
			["1y", 12, "1 year"],
			["2y", 24, "2 years"],
		],
	);
});

test("expiryFromPreset: start of the local day at +1, +3, +6, +12, +24 months", () => {
	assert.equal(expiryFromPreset("1m", NOW).getTime(), new Date(2026, 11, 19).getTime());
	assert.equal(expiryFromPreset("3m", NOW).getTime(), new Date(2027, 1, 19).getTime());
	assert.equal(expiryFromPreset("6m", NOW).getTime(), new Date(2027, 4, 19).getTime());
	assert.equal(expiryFromPreset("1y", NOW).getTime(), new Date(2027, 10, 19).getTime());
	assert.equal(expiryFromPreset("2y", NOW).getTime(), new Date(2028, 10, 19).getTime());
});

test("expiryFromPreset: end of month brought back to the last day of the target month", () => {
	assert.equal(expiryFromPreset("1m", new Date(2026, 0, 31, 23, 59)).getTime(), new Date(2026, 1, 28).getTime());
	assert.equal(expiryFromPreset("1y", new Date(2028, 1, 29, 8, 0)).getTime(), new Date(2029, 1, 28).getTime());
});

test("parseExpiry: a future date less than 10 years away is returned as is", () => {
	const iso = new Date(2026, 11, 19).toISOString();
	const d = parseExpiry(iso, NOW);
	assert.ok(d instanceof Date);
	assert.equal(d!.toISOString(), iso);
});

test("parseExpiry: empty, invalid, past or far away is null", () => {
	assert.equal(parseExpiry("", NOW), null);
	assert.equal(parseExpiry("   ", NOW), null);
	assert.equal(parseExpiry(null, NOW), null);
	assert.equal(parseExpiry(undefined, NOW), null);
	assert.equal(parseExpiry("not a date", NOW), null);
	assert.equal(parseExpiry(new Date(2026, 10, 18).toISOString(), NOW), null);
	assert.equal(parseExpiry(NOW.toISOString(), NOW), null, "strictly after now");
	assert.equal(parseExpiry(new Date(2099, 0, 1).toISOString(), NOW), null);
	assert.equal(parseExpiry(new Date(2036, 10, 19, 10, 30).toISOString(), NOW), null, "exactly 10 years excluded");
	assert.ok(parseExpiry(new Date(2036, 10, 19, 10, 29).toISOString(), NOW));
});

test("formatExpiry: day, month name, year, no leading zero", () => {
	assert.equal(formatExpiry(new Date(2026, 11, 19)), "19 Dec 2026");
	assert.equal(formatExpiry(new Date(2027, 0, 5)), "5 Jan 2027");
});

test("expiryBucket: YYYYMMDDHH in UTC, changes hour by hour", () => {
	assert.equal(expiryBucket(new Date("2026-11-19T10:30:00Z")), "2026111910");
	assert.equal(expiryBucket(new Date("2026-11-19T10:59:59Z")), "2026111910");
	assert.equal(expiryBucket(new Date("2026-11-19T11:00:00Z")), "2026111911");
	assert.equal(expiryBucket(new Date("2027-01-02T03:04:05Z")), "2027010203");
});

test("@common index: thread-expiry exported", () => {
	assert.match(src("packages/common/src/index.ts"), /export \* from "\.\/thread-expiry";/);
});

// db/ is not in the image build context: the migration is only checked inside the repository.
const migPath = "db/init/migrations/community_009_migration.sql";
let mig: string | null = null;
try {
	mig = src(migPath).replace(/--[^\n]*/g, "");
} catch {
	console.log(`skip  migration community_009 (db/ absent)`);
}
if (mig !== null) {
	test("migration community_009: column, partial index, starred trigger, replayable", () => {
		assert.match(mig!, /ADD COLUMN IF NOT EXISTS expires_at timestamptz/i);
		assert.match(mig!, /CREATE INDEX IF NOT EXISTS ix_mbth_expires_at\b[\s\S]*WHERE expires_at IS NOT NULL/i);
		assert.match(mig!, /CREATE OR REPLACE FUNCTION public\.mbth_expiry_guard/i);
		assert.match(mig!, /DROP TRIGGER IF EXISTS mbth_expiry_guard/i);
		assert.match(mig!, /WHEN \(NEW\.starred AND NEW\.expires_at IS NOT NULL\)/i);
	});
}

test("drizzle schema: expiresAt and partial index on mailbox_threads", () => {
	const s = src("packages/db/src/drizzle/schema.ts");
	assert.match(s, /expiresAt: timestamp\("expires_at", \{ withTimezone: true \}\)/);
	assert.match(s, /index\("ix_mbth_expires_at"\)\s*\.on\(t\.expiresAt\)\s*\.where\(sql`\$\{t\.expiresAt\} is not null`\)/);
});

if (failed) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nthread-expiry: all green");
