// Outbox: queuing a send (a draft_messages ledger row, then the SCHEDULED_JOB job with the same
// id) and cancellation arbitrated by the row: the CAS scheduled -> canceled comes before any job
// removal and any draft restore; when lost, nothing is restored and the real state is returned.
// In-memory fake ledger (same CAS as the SQL).
// From the root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/outbox-cancel.ts
import assert from "node:assert/strict";
import { cancelSend, enqueueSend, messageIdFor, sendNowPlanOf } from "../../../packages/common/src/outbox";
import { DRAFT_MAYBE_SENT_ERROR } from "../../../packages/common/src/draft-send";
import { SCHEDULED_JOB } from "../../../packages/common/src/schedule-send";

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

type Row = {
	id: string;
	status: string;
	payload: Record<string, any>;
	acceptanceUnknown?: boolean;
	deliveryState?: string;
	acceptedAt?: Date | null;
	sentRowId?: string | null;
	dismissedAt?: Date | null;
};

// Fake ledger: each transition is an UPDATE ... WHERE status = expected.
const ledger = (rows: Row[]) => {
	const byId = new Map(rows.map((r) => [r.id, { ...r }]));
	const cas = (id: string, from: string, to: string) => {
		const r = byId.get(id);
		if (!r || r.status !== from) return null;
		r.status = to;
		return { ...r };
	};
	return { byId, cas };
};

(async () => {
await test("messageIdFor: domain of the sender, like nodemailer", () => {
	assert.equal(messageIdFor("me@example.com", "u-1"), "<u-1@example.com>");
	assert.equal(messageIdFor('"Sam" <Sam@Exemple.FR>', "u-2"), "<u-2@exemple.fr>");
	assert.equal(messageIdFor("no-domain", "u-3"), "<u-3@localhost>");
});

await test("enqueueSend: scheduled row with origin and Message-ID, then SCHEDULED_JOB job with the same id", async () => {
	const inserted: any[] = [];
	const jobs: any[] = [];
	const now = new Date("2026-11-13T08:00:00Z");
	const sendAt = new Date("2026-11-13T08:00:10Z");
	const res = await enqueueSend(
		{
			payload: { draftMessageId: "d-1", subject: "s" },
			identityId: "i-1",
			mailboxId: "m-1",
			origin: "undo",
			sendAt,
			fromAddress: "me@example.com",
		},
		{
			uuid: () => "u-9",
			insertRow: async (v) => {
				inserted.push(v);
				return { id: "row-1", scheduledAt: v.scheduledAt };
			},
			addJob: async (name, data, opts) => void jobs.push({ name, data, opts }),
			deleteRow: async () => assert.fail("nothing to remove"),
		},
		now,
	);
	assert.equal(res.ok, true);
	assert.equal(inserted[0].status, "scheduled");
	assert.equal(inserted[0].origin, "undo");
	assert.equal(inserted[0].messageId, "<u-9@example.com>");
	assert.equal(+inserted[0].scheduledAt, +sendAt);
	assert.equal(jobs[0].name, SCHEDULED_JOB);
	assert.equal(jobs[0].opts.jobId, "row-1");
	assert.equal(jobs[0].opts.delay, 10_000);
	assert.equal(jobs[0].data.imapDraftId, "d-1");
	assert.equal(jobs[0].opts.attempts ?? 1, 1, "never an automatic resend");
	if (res.ok) assert.equal(res.rowId, "row-1");
});

await test("enqueueSend: job add fails -> row removed, error returned", async () => {
	const deleted: string[] = [];
	const res = await enqueueSend(
		{ payload: {}, identityId: "i-1", mailboxId: "m-1", origin: "direct", sendAt: new Date(), fromAddress: "a@b.fr" },
		{
			insertRow: async (v) => ({ id: "row-2", scheduledAt: v.scheduledAt }),
			addJob: async () => {
				throw new Error("redis down");
			},
			deleteRow: async (id) => void deleted.push(id),
		},
	);
	assert.equal(res.ok, false);
	assert.deepEqual(deleted, ["row-2"]);
});

await test("enqueueSend: a new send of the same draft dismisses its previous failures", async () => {
	const superseded: string[] = [];
	await enqueueSend(
		{ payload: { draftMessageId: "d-7" }, identityId: "i-1", mailboxId: "m-1", origin: "undo", sendAt: new Date(), fromAddress: "a@b.fr" },
		{
			insertRow: async (v) => ({ id: "row-3", scheduledAt: v.scheduledAt }),
			addJob: async () => {},
			deleteRow: async () => {},
			supersede: async (draftId) => void superseded.push(draftId),
		},
	);
	assert.deepEqual(superseded, ["d-7"]);
});

await test("enqueueSend: draft mark set before the job; refused -> row removed without job; job fails -> mark removed", async () => {
	// An immediate send that fails fast (mark removed by the worker) must not see its mark set again
	// afterwards: it comes before the job is added.
	const calls: string[] = [];
	const base = {
		insertRow: async (v: any) => (calls.push("insert"), { id: "row-4", scheduledAt: v.scheduledAt }),
		addJob: async () => void calls.push("job"),
		deleteRow: async () => void calls.push("delete"),
		unmark: async () => void calls.push("unmark"),
	};
	const input = { payload: { draftMessageId: "d-8" }, identityId: "i-1", mailboxId: "m-1", origin: "undo" as const, sendAt: new Date(), fromAddress: "a@b.fr" };
	const ok = await enqueueSend(input, { ...base, mark: async (row) => (calls.push(`mark:${row.id}`), true) });
	assert.equal(ok.ok, true);
	assert.deepEqual(calls, ["insert", "mark:row-4", "job"]);

	calls.length = 0;
	const refused = await enqueueSend(input, { ...base, mark: async () => false });
	assert.equal(refused.ok, false);
	assert.deepEqual(calls, ["insert", "delete"], "no job without a mark");

	calls.length = 0;
	const noJob = await enqueueSend(input, {
		...base,
		mark: async () => true,
		addJob: async () => {
			throw new Error("redis down");
		},
	});
	assert.equal(noJob.ok, false);
	assert.deepEqual(calls, ["insert", "delete", "unmark"]);
});

// Previous send of the same draft interrupted (the server did not answer: it may have been sent):
// sending it again from the editor might send the mail twice, and dismissing it silently would
// erase the only trace. Explicit refusal, no row, no job, nothing dismissed.
await test("enqueueSend: draft with an interrupted send -> \"may already have been sent\" refusal, nothing created", async () => {
	const calls: string[] = [];
	const io = {
		insertRow: async (v: any) => (calls.push("insert"), { id: "row-5", scheduledAt: v.scheduledAt }),
		addJob: async () => void calls.push("job"),
		deleteRow: async () => void calls.push("delete"),
		mark: async () => (calls.push("mark"), true),
		supersede: async () => void calls.push("supersede"),
	};
	const input = { payload: { draftMessageId: "d-9" }, identityId: "i-1", mailboxId: "m-1", origin: "undo" as const, sendAt: new Date(), fromAddress: "a@b.fr" };
	const asked: string[] = [];
	const res = await enqueueSend(input, { ...io, interrupted: async (id: string) => (asked.push(id), true) });
	assert.deepEqual(res, { ok: false, error: DRAFT_MAYBE_SENT_ERROR, maybeSent: true });
	assert.deepEqual(asked, ["d-9"]);
	assert.deepEqual(calls, []);
	assert.equal(DRAFT_MAYBE_SENT_ERROR, "This message may already have been sent: check the Outbox");
	// Without an interrupted send, or without an original draft: normal send.
	assert.equal((await enqueueSend(input, { ...io, interrupted: async () => false })).ok, true);
	const asked2: string[] = [];
	const direct = await enqueueSend({ ...input, payload: {} }, { ...io, interrupted: async (id: string) => (asked2.push(id), true) });
	assert.equal(direct.ok, true);
	assert.deepEqual(asked2, []);
});

const cancelIo = (l: ReturnType<typeof ledger>, id: string, calls: string[]) => ({
	casCancel: async () => l.cas(id, "scheduled", "canceled"),
	readRow: async () => (l.byId.get(id) ? { ...l.byId.get(id)! } : null),
	removeJob: async () => void calls.push("removeJob"),
	restore: async () => void calls.push("restore"),
	unlock: async () => void calls.push("unlock"),
	settle: async (action: string) => void calls.push(`settle:${action}`),
});

await test("cancel against the worker claim: a single winner", async () => {
	for (const order of ["cancel-first", "claim-first"] as const) {
		const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
		const calls: string[] = [];
		let claimed: unknown = null;
		const claim = async () => (claimed = l.cas("r", "scheduled", "sending"));
		let res;
		if (order === "cancel-first") {
			res = await cancelSend(cancelIo(l, "r", calls));
			await claim();
		} else {
			await claim();
			res = await cancelSend(cancelIo(l, "r", calls));
		}
		const winners = (res.cancelled ? 1 : 0) + (claimed ? 1 : 0);
		assert.equal(winners, 1, order);
		if (order === "claim-first") assert.deepEqual(calls, [], "no restore without a won CAS");
	}
});

await test("cancel a send in progress or sent: refused, real state, draft not restored", async () => {
	for (const [status, state] of [["sending", "sending"], ["sent", "delivered"], ["failed", "failed"]] as const) {
		const l = ledger([{ id: "r", status, payload: {} }]);
		const calls: string[] = [];
		const res = await cancelSend(cancelIo(l, "r", calls));
		assert.equal(res.cancelled, false, status);
		assert.equal(res.state, state);
		assert.ok(!calls.includes("restore") && !calls.includes("removeJob"), status);
	}
});

// Mark left on the draft while the row is finished (failed cleanup after send, mark removal or
// restore): Cancel restores nothing but puts the draft back in order, otherwise it stays locked
// forever.
await test("cancel lost on a finished row: the draft is cleaned up (sent) or unlocked", async () => {
	const at = new Date("2026-11-13T09:00:00Z");
	const cases: [Row, string[]][] = [
		[{ id: "r", status: "sending", payload: {} }, []],
		[{ id: "r", status: "sent", payload: {}, acceptedAt: at, sentRowId: null }, []],
		[{ id: "r", status: "sent", payload: {}, acceptedAt: at, sentRowId: "m-1" }, ["settle:delete"]],
		[{ id: "r", status: "failed", payload: {} }, ["settle:unlock"]],
		[{ id: "r", status: "failed", payload: {}, acceptanceUnknown: true, dismissedAt: at }, ["settle:unlock"]],
		[{ id: "r", status: "sent", payload: {}, acceptedAt: at, sentRowId: "m-1", dismissedAt: at, deliveryState: "rejected" }, ["settle:unlock"]],
	];
	for (const [row, expected] of cases) {
		const l = ledger([row]);
		const calls: string[] = [];
		const res = await cancelSend(cancelIo(l, "r", calls));
		assert.equal(res.cancelled, false, JSON.stringify(row));
		assert.deepEqual(calls, expected, JSON.stringify(row));
	}
	// A failed cleanup does not change the answer.
	const l = ledger([{ id: "r", status: "failed", payload: {} }]);
	const res = await cancelSend({
		...cancelIo(l, "r", []),
		settle: async () => {
			throw new Error("db down");
		},
	});
	assert.deepEqual(res, { cancelled: false, state: "failed" });
});

await test("cancel won: job removed then draft restored; already canceled: unlock only, never a restore without a won CAS", async () => {
	const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
	const calls: string[] = [];
	const first = await cancelSend(cancelIo(l, "r", calls));
	assert.equal(first.cancelled, true);
	assert.deepEqual(calls, ["removeJob", "restore"]);
	// Second click (stale tab): the content of the row does not overwrite a draft edited since.
	const again = await cancelSend(cancelIo(l, "r", calls));
	assert.equal(again.cancelled, true);
	assert.deepEqual(calls, ["removeJob", "restore", "removeJob", "unlock"]);
	assert.equal(l.byId.get("r")!.status, "canceled");
});

await test("cancel: a failed job removal or restore does not undo the cancellation", async () => {
	const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
	const res = await cancelSend({
		...cancelIo(l, "r", []),
		removeJob: async () => {
			throw new Error("redis down");
		},
		restore: async () => {
			throw new Error("imap down");
		},
	});
	assert.equal(res.cancelled, true);
	assert.equal(l.byId.get("r")!.status, "canceled");
});

// Job fails and the row is not removed (database unavailable in turn): the scheduled row without
// a job would stay "scheduled" for nothing (and be replayed by the pickup at boot); it becomes
// canceled.
await test("enqueueSend: job fails then row not removed -> row canceled, never scheduled without a job", async () => {
	const calls: string[] = [];
	const res = await enqueueSend(
		{ payload: { draftMessageId: "d-10" }, identityId: "i-1", mailboxId: "m-1", origin: "undo", sendAt: new Date(), fromAddress: "a@b.fr" },
		{
			insertRow: async (v: any) => (calls.push("insert"), { id: "row-6", scheduledAt: v.scheduledAt }),
			addJob: async () => {
				throw new Error("redis down");
			},
			deleteRow: async () => {
				calls.push("delete");
				throw new Error("db down");
			},
			cancelRow: async (id: string) => void calls.push(`cancel:${id}`),
		},
	);
	assert.equal(res.ok, false);
	assert.deepEqual(calls, ["insert", "delete", "cancel:row-6"]);
});

// "Send now": the row decides. Job waiting -> promoted; job gone, failed or completed while the
// row is still scheduled -> added again from the row; row out of scheduled (sent, canceled) or
// job already running -> nothing.
await test("sendNowPlanOf: promote, add again from the row, or nothing", () => {
	assert.equal(sendNowPlanOf("delayed", "scheduled"), "promote");
	assert.equal(sendNowPlanOf("delayed", null), "promote", "send from before the ledger (undo-send-*), without a row");
	for (const state of [null, "unknown", "failed", "completed"]) {
		assert.equal(sendNowPlanOf(state, "scheduled"), "readd", String(state));
	}
	for (const state of ["waiting", "active", "prioritized"]) {
		assert.equal(sendNowPlanOf(state, "scheduled"), "none", state);
	}
	for (const status of ["sending", "sent", "canceled", "failed"]) {
		assert.equal(sendNowPlanOf("delayed", status), "none", status);
		assert.equal(sendNowPlanOf(null, status), "none", status);
	}
	assert.equal(sendNowPlanOf(null, null), "none");
	assert.equal(sendNowPlanOf("failed", null), "none");
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
})();
