// Send state of a draft (packages/common/src/draft-send.ts): pendingSend kept by an
// autosave update, sendError cleared by an edit. No database.
// Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/draft-send.ts
import assert from "node:assert/strict";
import {
	DRAFT_PENDING_ERROR,
	draftSendStateOf,
	mergeDraftMeta,
	pendingSendAlive,
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

test("refusal message of the guard", () => {
	assert.equal(DRAFT_PENDING_ERROR, "This draft is scheduled; cancel the scheduled send first");
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
