// Scheduled send (packages/common/src/schedule-send.ts): the BullMQ job is built in one place
// for the web editor, the drafts service and the worker's startup recovery; the IMAP draft is
// found from a "send-and-reconcile" job as from a "send-scheduled-draft" job. No database, no
// Redis.
// From the repository root:
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/scheduled-send.ts
import assert from "node:assert/strict";
import { isScheduledMark } from "../../../packages/common/src/draft-send";
import {
	SCHEDULED_JOB,
	imapDraftIdOfJob,
	rehydrateActionOf,
	scheduledJobOf,
	scheduledPendingSend,
} from "../../../packages/common/src/schedule-send";

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

const NOW = Date.parse("2026-11-12T09:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
	id: "row-1",
	identityId: "ident-1",
	scheduledAt: new Date("2026-11-12T11:00:00Z"),
	payload: { draftMessageId: "imap-draft-1", identityId: "ident-1" },
	...over,
});

test("scheduled job: jobId = row, delay until the time, identity and IMAP draft in the data", () => {
	const job = scheduledJobOf(row(), NOW);
	assert.equal(job.name, SCHEDULED_JOB);
	assert.equal(job.name, "send-scheduled-draft");
	assert.deepEqual(job.data, { draftMessageId: "row-1", identityId: "ident-1", imapDraftId: "imap-draft-1" });
	assert.equal(job.opts.jobId, "row-1");
	assert.equal(job.opts.delay, 2 * 3600_000);
});

test("recovery: a time already passed gives a delay of 0, never negative", () => {
	assert.equal(scheduledJobOf(row({ scheduledAt: new Date("2026-11-12T08:00:00Z") }), NOW).opts.delay, 0);
});

test("without an IMAP draft (draft deleted or never saved): imapDraftId null", () => {
	const job = scheduledJobOf(row({ payload: {} }), NOW);
	assert.equal(job.data.imapDraftId, null);
});

test("pendingSend mark of the draft: jobId of the row, ISO time", () => {
	assert.deepEqual(scheduledPendingSend(row()), { jobId: "row-1", sendAt: "2026-11-12T11:00:00.000Z" });
});

test("IMAP draft of a job: draftMessageId for a delayed send, imapDraftId for a scheduled one", () => {
	assert.equal(imapDraftIdOfJob("send-and-reconcile", { draftMessageId: "d1" }), "d1");
	assert.equal(imapDraftIdOfJob("send-scheduled-draft", { draftMessageId: "row-1", imapDraftId: "d2" }), "d2");
	assert.equal(imapDraftIdOfJob("send-scheduled-draft", { draftMessageId: "row-1", imapDraftId: null }), "");
	assert.equal(imapDraftIdOfJob("send-and-reconcile", {}), "");
	assert.equal(imapDraftIdOfJob("other", { draftMessageId: "x" }), "");
});

// Startup recovery: what to do with a "scheduled" row depending on the state of its job.
test("rehydrateActionOf: add, keep, fail, never replay", () => {
	assert.equal(rehydrateActionOf(null), "add");
	for (const s of ["delayed", "waiting", "active", "prioritized", "paused", "waiting-children"]) {
		assert.equal(rehydrateActionOf(s), "keep", s);
	}
	// Failed job while the row stayed "scheduled": the row fails, never retried.
	assert.equal(rehydrateActionOf("failed"), "fail");
	// Completed job, row still "scheduled": an anomaly, reported, no second send.
	assert.equal(rehydrateActionOf("completed"), "skip");
	assert.equal(rehydrateActionOf("unknown"), "keep");
});

test("isScheduledMark: jobId of a scheduled row, not of an undo-send- countdown", () => {
	assert.equal(isScheduledMark({ jobId: "5c1e0f6e-1111-4222-8333-444455556666", sendAt: "x" }), true);
	assert.equal(isScheduledMark({ jobId: "undo-send-5c1e0f6e", sendAt: "x" }), false);
	assert.equal(isScheduledMark(null), false);
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
