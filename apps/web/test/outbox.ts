// Outbox: queued mails that have not actually left yet are shown as being sent. One
// draft_messages row per send (ledger); the displayed state, the visibility, the counter and the
// actions are computed by a single pure function. Migration community_008 read as text (no
// Postgres in the tests).
// From the root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/outbox.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	dismissRestoresDraft,
	isOutboxVisible,
	outboxActionsOf,
	outboxCountOf,
	sendStateOf,
	type LedgerStateRow,
} from "../../../packages/common/src/outbox-state";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const row = (o: Partial<LedgerStateRow>): LedgerStateRow => ({
	status: "scheduled",
	deliveryState: "none",
	acceptanceUnknown: false,
	acceptedAt: null,
	dismissedAt: null,
	...o,
});

test("sendStateOf: truth table", () => {
	const cases: [Partial<LedgerStateRow>, string | null][] = [
		[{ status: "scheduled" }, "pending"],
		[{ status: "sending" }, "sending"],
		[{ status: "failed" }, "failed"],
		[{ status: "failed", acceptanceUnknown: true }, "interrupted"],
		[{ status: "canceled" }, "canceled"],
		[{ status: "sent", deliveryState: "none" }, "delivered"],
		[{ status: "sent", deliveryState: "delivered" }, "delivered"],
		[{ status: "sent", deliveryState: "queued" }, "queued"],
		[{ status: "sent", deliveryState: "canceling" }, "canceling"],
		[{ status: "sent", deliveryState: "rejected" }, "rejected"],
		[{ status: "sent", deliveryState: "unknown" }, "unknown"],
		[{ status: "sent", deliveryState: null }, "delivered"],
		[{ status: "draft" }, null],
	];
	for (const [o, want] of cases) assert.equal(sendStateOf(row(o)), want, JSON.stringify(o));
});

test("visibility: in progress always, failures until dismissed, never delivered nor canceled", () => {
	const visible = (o: Partial<LedgerStateRow>) => isOutboxVisible(row(o));
	assert.equal(visible({ status: "scheduled" }), true);
	assert.equal(visible({ status: "sending" }), true);
	assert.equal(visible({ status: "sent", deliveryState: "queued" }), true);
	assert.equal(visible({ status: "sent", deliveryState: "canceling" }), true);
	assert.equal(visible({ status: "sent", deliveryState: "unknown" }), true);
	assert.equal(visible({ status: "failed" }), true);
	assert.equal(visible({ status: "failed", acceptanceUnknown: true }), true);
	assert.equal(visible({ status: "sent", deliveryState: "rejected" }), true);
	assert.equal(visible({ status: "failed", dismissedAt: new Date() }), false);
	assert.equal(visible({ status: "failed", acceptanceUnknown: true, dismissedAt: "2026-11-13T08:00:00Z" }), false);
	assert.equal(visible({ status: "sent", deliveryState: "rejected", dismissedAt: new Date() }), false);
	assert.equal(visible({ status: "sent" }), false);
	assert.equal(visible({ status: "canceled" }), false);
	assert.equal(visible({ status: "draft" }), false);
});

test("counter: visible rows, alert outside pending, sending and queued", () => {
	assert.deepEqual(outboxCountOf([]), { total: 0, alert: 0 });
	assert.deepEqual(
		outboxCountOf([
			row({ status: "scheduled" }),
			row({ status: "sending" }),
			row({ status: "sent", deliveryState: "queued" }),
			row({ status: "sent" }),
			row({ status: "canceled" }),
			row({ status: "failed", dismissedAt: new Date() }),
		]),
		{ total: 3, alert: 0 },
	);
	assert.deepEqual(
		outboxCountOf([
			row({ status: "scheduled" }),
			row({ status: "failed" }),
			row({ status: "failed", acceptanceUnknown: true }),
			row({ status: "sent", deliveryState: "unknown" }),
		]),
		{ total: 4, alert: 3 },
	);
});

test("actions: cancel and send now only while pending", () => {
	assert.deepEqual(outboxActionsOf(row({ status: "scheduled" })), {
		cancel: true,
		sendNow: true,
		retry: false,
		confirmRetry: false,
		dismiss: false,
	});
	for (const o of [{ status: "sending" }, { status: "sent" }, { status: "canceled" }] as const) {
		const a = outboxActionsOf(row(o));
		assert.equal(a.cancel || a.sendNow || a.retry || a.dismiss, false, o.status);
	}
});

test("actions: retry a certain failure without confirmation, an interrupted send with it", () => {
	const failed = outboxActionsOf(row({ status: "failed" }));
	assert.equal(failed.retry, true);
	assert.equal(failed.confirmRetry, false);
	assert.equal(failed.dismiss, true);
	const interrupted = outboxActionsOf(row({ status: "failed", acceptanceUnknown: true }));
	assert.equal(interrupted.retry, true);
	assert.equal(interrupted.confirmRetry, true);
	assert.equal(interrupted.dismiss, true);
});

test("actions: never retry a send accepted by the server", () => {
	const a = outboxActionsOf(row({ status: "failed", acceptedAt: new Date() }));
	assert.equal(a.retry, false);
	const rejected = outboxActionsOf(row({ status: "sent", deliveryState: "rejected", acceptedAt: new Date() }));
	assert.equal(rejected.retry, false);
	assert.equal(rejected.dismiss, true);
});

// "Back to drafts" only recreates a draft for a send that came from a draft (undo delay,
// scheduled); a direct send (API, unsubscribe, invitation) had none: it is only dismissed.
test("dismiss: draft recreated for undo and scheduled, never for a direct send", () => {
	assert.equal(dismissRestoresDraft("undo"), true);
	assert.equal(dismissRestoresDraft("scheduled"), true);
	assert.equal(dismissRestoresDraft("direct"), false);
	assert.equal(dismissRestoresDraft(null), false);
});

// db/ is not in the build context of the image: migration checks run only in the repository.
const migrationPath = join(__dirname, "../../../db/init/migrations/community_008_migration.sql");
const hasMigration = existsSync(migrationPath);
const migrationTest: typeof test = hasMigration ? test : (label) => console.log(`skip  ${label} (db/ absent)`);
const sqlText = hasMigration ? readFileSync(migrationPath, "utf8") : "";
const code = sqlText.replace(/--[^\n]*/g, "");

migrationTest("migration community_008: ledger columns, replayable", () => {
	for (const col of [
		"origin",
		"message_id",
		"accepted_at",
		"acceptance_unknown",
		"smtp_response",
		"delivery_state",
		"queue_ref",
		"last_error",
		"next_attempt_at",
		"delivery_checked_at",
		"delivered_at",
		"dismissed_at",
		"rendered",
		"sent_row_id",
	]) {
		assert.match(code, new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\b`, "i"), col);
	}
	assert.match(code, /origin\s+text\s+NOT NULL\s+DEFAULT\s+'scheduled'/i);
	assert.match(code, /delivery_state\s+text\s+NOT NULL\s+DEFAULT\s+'none'/i);
	assert.match(code, /acceptance_unknown\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i);
	assert.doesNotMatch(code, /REFERENCES/i, "sent_row_id without FK");
	assert.doesNotMatch(code, /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i, "index rejouables");
});

migrationTest("migration community_008: partial unique index on (identity_id, message_id)", () => {
	assert.match(
		code,
		/CREATE UNIQUE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(public\.)?draft_messages\s*\(\s*identity_id\s*,\s*message_id\s*\)\s*WHERE\s+message_id IS NOT NULL/i,
	);
	assert.match(
		code,
		/CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(public\.)?draft_messages\s*\(\s*identity_id\s*,\s*status\s*,\s*delivery_state\s*\)/i,
	);
});

const updates = code.match(/UPDATE\s+(public\.)?draft_messages[\s\S]*?;/gi) ?? [];

migrationTest("migration community_008: only failures from before the ledger are dismissed, even replayed", () => {
	const update = updates.find((u) => /SET\s+dismissed_at\s*=\s*now\(\)\s+WHERE/i.test(u)) ?? "";
	assert.match(update, /SET\s+dismissed_at\s*=\s*now\(\)/i);
	assert.match(update, /status\s*=\s*'failed'/i);
	assert.match(update, /message_id IS NULL/i, "a ledger failure (message_id set) stays visible");
	assert.match(update, /dismissed_at IS NULL/i);
});

// "sending" row left by the previous worker (without message_id): the sweep does not pick it up
// (staleSending requires message_id), the migration turns it into an interrupted failure (may have
// been sent), dismissed from the Outbox.
migrationTest("migration community_008: a sending row from before the ledger becomes a dismissed interrupted failure, even replayed", () => {
	const update = updates.find((u) => /WHERE\s+status\s*=\s*'sending'/i.test(u)) ?? "";
	assert.match(update, /status\s*=\s*'failed'/i);
	assert.match(update, /acceptance_unknown\s*=\s*true/i);
	assert.match(update, /dismissed_at\s*=\s*now\(\)/i);
	assert.match(update, /message_id IS NULL/i, "a ledger send in progress is not touched");
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
