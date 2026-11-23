// Send state of a draft (packages/common/src/draft-send.ts): pendingSend kept by an
// autosave update, sendError cleared by an edit. No database.
// Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/draft-send.ts
import assert from "node:assert/strict";
import {
	DRAFT_MAYBE_SENT_ERROR,
	DRAFT_PENDING_ERROR,
	draftSendErrorOf,
	draftSendStateOf,
	mergeDraftMeta,
	pendingSendAlive,
	settleActionOf,
	type DraftSendFields,
} from "../../../packages/common/src/draft-send";

type Meta = DraftSendFields & { draftId: string; revision: number; subject?: string };

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

const pendingSend = { jobId: "undo-send-1", sendAt: "2026-11-02T09:00:30.000Z" };
const sendError = { message: "SMTP refused", at: "2026-11-02T09:01:00.000Z" };

test("autosave keeps pendingSend", () => {
	const prev: Meta = { draftId: "d", revision: 3, pendingSend };
	const merged = mergeDraftMeta<Meta>(prev, { draftId: "d", revision: 4 });
	assert.deepEqual(merged.pendingSend, pendingSend);
	assert.equal(merged.revision, 4);
});

test("pendingSend cleared (cancellation): the next autosave does not recreate it", () => {
	const prev: Meta = { draftId: "d", revision: 4 };
	const merged = mergeDraftMeta<Meta>(prev, { draftId: "d", revision: 5, pendingSend });
	assert.equal(merged.pendingSend, undefined);
});

test("an edit clears sendError", () => {
	const prev: Meta = { draftId: "d", revision: 2, sendError };
	const merged = mergeDraftMeta<Meta>(prev, { draftId: "d", revision: 3 });
	assert.equal(merged.sendError, undefined);
});

test("first write without previous meta", () => {
	const merged = mergeDraftMeta<Meta>(null, { draftId: "d", revision: 1 });
	assert.deepEqual(draftSendStateOf(merged), { pendingSend: null, sendError: null });
});

test("draftSendStateOf reads both markers", () => {
	assert.deepEqual(draftSendStateOf({ pendingSend, sendError }), { pendingSend, sendError });
	assert.deepEqual(draftSendStateOf(null), { pendingSend: null, sendError: null });
});

// Guard: a draft with a pending send is neither edited nor deleted behind its back.
test("pendingSendAlive: running countdown, scheduled, stale", () => {
	const now = Date.parse("2026-11-12T10:00:00.000Z");
	const countdown = (offsetMs: number) => ({ jobId: "undo-send-abc", sendAt: new Date(now + offsetMs).toISOString() });
	assert.equal(pendingSendAlive(null, now), false);
	assert.equal(pendingSendAlive(undefined, now), false);
	assert.equal(pendingSendAlive(countdown(30_000), now), true);
	assert.equal(pendingSendAlive(countdown(-2 * 60_000), now), true);
	// Countdown with no result for more than 3 minutes: unknown state, no longer blocks.
	assert.equal(pendingSendAlive(countdown(-4 * 60_000), now), false);
	// Scheduled send (jobId = draft_messages row): alive as long as the mark exists, even past
	// its time (worker stopped): only cancelling or sending clears it.
	const scheduled = (offsetMs: number) => ({ jobId: "5c1e0f6e-1111-4222-8333-444455556666", sendAt: new Date(now + offsetMs).toISOString() });
	assert.equal(pendingSendAlive(scheduled(24 * 3600_000), now), true);
	assert.equal(pendingSendAlive(scheduled(-3600_000), now), true);
	assert.equal(pendingSendAlive({ jobId: "x", sendAt: "not a date" }, now), false);
});

// Mark pointing to a finished ledger row (cleanup after a send, failed restore or mark
// removal): the draft is no longer locked, Cancel and the sweep put it back in order.
test("pendingSendAlive: a mark to a finished or missing row no longer locks", () => {
	const now = Date.parse("2026-11-13T10:00:00.000Z");
	const mark = { jobId: "5c1e0f6e-1111-4222-8333-444455556666", sendAt: new Date(now - 3600_000).toISOString() };
	const at = new Date(now - 60_000);
	// Row not read (synchronous caller): previous behavior, alive.
	assert.equal(pendingSendAlive(mark, now), true);
	assert.equal(pendingSendAlive(mark, now, { status: "scheduled" }), true);
	assert.equal(pendingSendAlive(mark, now, { status: "sending" }), true);
	// Accepted, Sent copy not made yet: the draft cleanup follows finalizing.
	assert.equal(pendingSendAlive(mark, now, { status: "sent", acceptedAt: at, sentRowId: null }), true);
	assert.equal(pendingSendAlive(mark, now, { status: "sent", acceptedAt: at, sentRowId: "m-1" }), false);
	assert.equal(pendingSendAlive(mark, now, { status: "failed" }), false);
	assert.equal(pendingSendAlive(mark, now, { status: "canceled" }), false);
	assert.equal(pendingSendAlive(mark, now, { status: "sent", acceptedAt: at, sentRowId: "m-1", dismissedAt: at }), false);
	assert.equal(pendingSendAlive(mark, now, null), false);
	// An "undo-send-*" countdown does not depend on the row.
	const countdown = { jobId: "undo-send-abc", sendAt: new Date(now - 30_000).toISOString() };
	assert.equal(pendingSendAlive(countdown, now, null), true);
});

test("settleActionOf: draft deleted if the send has its Sent copy, mark removed otherwise", () => {
	const at = new Date("2026-11-13T09:00:00.000Z");
	assert.equal(settleActionOf({ status: "scheduled" }), null);
	assert.equal(settleActionOf({ status: "sending" }), null);
	assert.equal(settleActionOf({ status: "sent", acceptedAt: at, sentRowId: null }), null);
	assert.equal(settleActionOf({ status: "sent", acceptedAt: at, sentRowId: "m-1" }), "delete");
	assert.equal(settleActionOf({ status: "failed" }), "unlock");
	assert.equal(settleActionOf({ status: "canceled" }), "unlock");
	// Dismissed (rejection reported then "Dismiss"): the content stays in the draft.
	assert.equal(settleActionOf({ status: "sent", acceptedAt: at, sentRowId: "m-1", dismissedAt: at }), "unlock");
	assert.equal(settleActionOf({ status: "failed", dismissedAt: at }), "unlock");
	// Legacy "sent" row from before the ledger (never accepted nor finalized): only the mark goes.
	assert.equal(settleActionOf({ status: "sent" }), "unlock");
});

// Failure with an unknown outcome (interrupted, connection cut after sending): the draft error
// says so, otherwise a click on Send might send the mail twice.
test("draftSendErrorOf: a failure with an unknown outcome says it may already have been sent", () => {
	assert.equal(draftSendErrorOf({ acceptanceUnknown: false }, "550 refused"), "550 refused");
	assert.equal(
		draftSendErrorOf({ acceptanceUnknown: true }, "Sending interrupted"),
		`${DRAFT_MAYBE_SENT_ERROR}. Sending interrupted`,
	);
	assert.equal(draftSendErrorOf({ acceptanceUnknown: true }, null), DRAFT_MAYBE_SENT_ERROR);
});

test("refusal message of the guard", () => {
	assert.equal(DRAFT_PENDING_ERROR, "This draft is scheduled; cancel the scheduled send first");
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
