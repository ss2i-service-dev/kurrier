// Outbox: send pipeline of the worker (apps/worker/lib/send/pipeline.ts).
// Order: claim (CAS scheduled -> sending), render outside any transaction, SMTP with the
// Message-ID of the row, a single "accepted" UPDATE (sent, accepted_at), then idempotent
// finalizing (Sent copy) in a transaction, non-replayable effects (S3 eml, search) after the commit.
// After a 250, nothing writes "failed" any more: a mail that left is never offered for resending.
// In-memory fake ledger with the same CAS as the SQL; the fake SMTP fails if a transaction is
// open (no irreversible effect inside a transaction that can still fail).
// Run (from the root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/send-accept-finalize.ts
import assert from "node:assert/strict";
import {
	ACCEPT_ATTEMPTS,
	finalizeSent,
	legacyLedgerRow,
	runSend,
	sweepLedger,
	type FinalizeIo,
	type LedgerRow,
	type LedgerStore,
	type SendDeps,
} from "../lib/send/pipeline";
import { outboxActionsOf } from "../../../packages/common/src/outbox-state";

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const NOW = new Date("2026-11-13T09:00:00Z");
const ledgerRow = (over: Partial<LedgerRow> = {}): LedgerRow => ({
	id: "row-1",
	status: "scheduled",
	payload: { draftMessageId: "imap-1", sentMailboxId: "mb-sent" },
	identityId: "ident-1",
	messageId: "<u-1@example.com>",
	acceptedAt: null,
	acceptanceUnknown: false,
	deliveryState: "none",
	rendered: null,
	sentRowId: null,
	updatedAt: NOW,
	...over,
});

type Smtp = { success: boolean; MessageId?: string; error?: string; response?: string; ambiguous?: boolean };

// Faux monde : ledger, table messages (unique (mailbox_id, message_id)), SMTP, S3.
type Draft = { jobId: string | null; ownerId: string };
type WorldRow = LedgerRow & { dismissedAt?: Date | null; lastError?: string | null };
const world = (
	rows: WorldRow[],
	opts: { smtp?: (messageId: string) => Promise<Smtp> | Smtp; drafts?: Record<string, Draft> } = {},
) => {
	const ledger = new Map<string, WorldRow>(rows.map((r) => [r.id, { ...r }]));
	// Drafts (messages): send mark pendingSend.jobId, by draft id.
	const drafts = new Map(Object.entries(opts.drafts ?? {}).map(([id, d]) => [id, { ...d }]));
	const settles: string[] = [];
	let failSettle = false;
	const msgs: { id: string; mailboxId: string; messageId: string }[] = [];
	const attachments: string[] = [];
	const marks: { imapDraftId: string; error: string }[] = [];
	const smtpCalls: string[] = [];
	const afterCommits: { messageRowId: string; inserted: boolean }[] = [];
	let inTx = false;
	// true: the "accepted" UPDATE always fails; a number: it fails that many times.
	let failAccept: boolean | number = false;
	const sleeps: number[] = [];
	let failAfterCommit = false;
	let failInsert = false;
	const clone = (r: LedgerRow | undefined) => (r ? { ...r } : null);
	const cas = (id: string, ok: (r: LedgerRow) => boolean, set: Partial<LedgerRow>) => {
		const r = ledger.get(id);
		if (!r || !ok(r)) return null;
		Object.assign(r, set, { updatedAt: NOW });
		return { ...r };
	};
	const store: LedgerStore = {
		get: async (id) => clone(ledger.get(id)),
		claim: async (id) => cas(id, (r) => r.status === "scheduled", { status: "sending" }),
		fail: async (id, f) =>
			cas(id, (r) => r.status === "sending", { status: "failed", acceptanceUnknown: f.ambiguous }),
		accept: async (id, a) => {
			if (failAccept === true) throw new Error("db down");
			if (typeof failAccept === "number" && failAccept > 0) {
				failAccept--;
				throw new Error("db down");
			}
			return cas(
				id,
				(r) => r.status === "sending" || (r.status === "failed" && r.acceptanceUnknown && !r.acceptedAt),
				{ status: "sent", acceptedAt: NOW, acceptanceUnknown: false, messageId: a.messageId, rendered: a.rendered },
			);
		},
		staleSending: async (before) =>
			[...ledger.values()]
				.filter((r) => r.status === "sending" && !r.acceptedAt && !!r.messageId && r.updatedAt < before)
				.map((r) => ({ ...r })),
		setMessageId: async (id, messageId) => cas(id, (r) => r.status === "sending" && !r.messageId, { messageId }),
		unfinalized: async (before) =>
			[...ledger.values()]
				.filter((r) => r.status === "sent" && r.acceptedAt && r.acceptedAt < before && r.deliveryState === "none" && !r.sentRowId)
				.map((r) => ({ ...r })),
		// Join messages (mark -> row); rows neither scheduled nor sending, touched between since and before.
		orphanMarks: async (before, since) =>
			[...ledger.values()]
				.filter((r) => !["scheduled", "sending"].includes(r.status) && r.updatedAt < before && r.updatedAt > since)
				.filter((r) => drafts.get(String(r.payload.draftMessageId))?.jobId === r.id)
				.map((r) => ({
					rowId: r.id,
					status: r.status,
					acceptedAt: r.acceptedAt,
					sentRowId: r.sentRowId,
					dismissedAt: r.dismissedAt ?? null,
					acceptanceUnknown: r.acceptanceUnknown,
					lastError: r.lastError ?? null,
					identityId: r.identityId,
					draftId: String(r.payload.draftMessageId),
					ownerId: drafts.get(String(r.payload.draftMessageId))!.ownerId,
				})),
	};
	const finalizeIo: FinalizeIo = {
		transaction: async (fn) => {
			const snapshot = { ledger: [...ledger.values()].map((r) => ({ ...r })), msgs: msgs.length, attachments: attachments.length };
			inTx = true;
			try {
				return await fn({
					lockRow: async (id) => clone(ledger.get(id)),
					ensureThread: async (row) => String(row.rendered?.threadId ?? "thread-new"),
					insertMessage: async (row) => {
						if (failInsert) throw new Error("insert failed");
						const mailboxId = String(row.rendered!.mailboxId);
						const existing = msgs.find((m) => m.mailboxId === mailboxId && m.messageId === row.messageId);
						if (existing) return { id: existing.id, inserted: false };
						const id = `msg-${msgs.length + 1}`;
						msgs.push({ id, mailboxId, messageId: String(row.messageId) });
						return { id, inserted: true };
					},
					insertAttachments: async (messageRowId) => void attachments.push(messageRowId),
					upsertThreadItem: async () => {},
					setSentRowId: async (id, messageRowId) => void Object.assign(ledger.get(id)!, { sentRowId: messageRowId }),
				});
			} catch (err) {
				for (const r of snapshot.ledger) ledger.set(r.id, r);
				msgs.length = snapshot.msgs;
				attachments.length = snapshot.attachments;
				throw err;
			} finally {
				inTx = false;
			}
		},
		afterCommit: async (f) => {
			assert.equal(inTx, false, "effects after the commit");
			afterCommits.push({ messageRowId: f.messageRowId, inserted: f.inserted });
			if (failAfterCommit) throw new Error("S3 down");
		},
	};
	const deps: SendDeps = {
		store,
		render: async (row) => ({
			from: "Me <me@example.com>",
			imapDraftId: row.payload.draftMessageId ?? null,
			rendered: { mailboxId: "mb-sent", subject: "Subject", threadId: null },
			send: async (messageId) => {
				assert.equal(inTx, false, "SMTP inside an open transaction");
				smtpCalls.push(messageId);
				// Lets the other concurrent claim run during the "SMTP" exchange.
				await new Promise((r) => setTimeout(r, 5));
				return opts.smtp ? opts.smtp(messageId) : { success: true, MessageId: messageId, response: "250 2.0.0 OK queued" };
			},
		}),
		newMessageId: () => "<gen-1@example.com>",
		finalize: (rowId) => finalizeSent(rowId, finalizeIo),
		markFailed: async (row, error) => void marks.push({ imapDraftId: String(row.payload.draftMessageId), error }),
		settleDraft: async (o, action) => {
			if (failSettle) throw new Error("db down");
			settles.push(`${o.rowId}:${action}`);
			if (action === "delete") drafts.delete(o.draftId);
			else drafts.get(o.draftId)!.jobId = null;
		},
		sleep: async (ms) => void sleeps.push(ms),
		log: () => {},
	};
	return {
		sleeps,
		ledger,
		drafts,
		settles,
		set failSettle(v: boolean) {
			failSettle = v;
		},
		msgs,
		attachments,
		marks,
		smtpCalls,
		afterCommits,
		store,
		finalizeIo,
		deps,
		set failAccept(v: boolean | number) {
			failAccept = v;
		},
		set failAfterCommit(v: boolean) {
			failAfterCommit = v;
		},
		set failInsert(v: boolean) {
			failInsert = v;
		},
	};
};

(async () => {
await test("accepted send: sent, accepted_at, Message-ID of the row, one Sent copy", async () => {
	const w = world([ledgerRow()]);
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "sent");
	assert.ok(row.acceptedAt);
	assert.deepEqual(w.smtpCalls, ["<u-1@example.com>"]);
	assert.equal(w.msgs.length, 1);
	assert.equal(row.sentRowId, "msg-1");
	assert.equal(row.rendered?.subject, "Subject", "body frozen on the row");
	assert.deepEqual(w.marks, []);
});

await test("250 then S3 failure: row sent with accepted_at, SMTP once, Retry refused", async () => {
	const w = world([ledgerRow()]);
	w.failAfterCommit = true;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "sent");
	assert.ok(row.acceptedAt);
	assert.equal(w.smtpCalls.length, 1);
	assert.equal(outboxActionsOf(row).retry, false);
	assert.deepEqual(w.marks, [], "no failure mark after a 250");
});

await test("250 then Sent copy failure: row sent without sent_row_id, replayed only once", async () => {
	const w = world([ledgerRow()]);
	w.failInsert = true;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	assert.equal(w.ledger.get("row-1")!.status, "sent");
	assert.equal(w.ledger.get("row-1")!.sentRowId, null);
	assert.equal(w.msgs.length, 0);
	w.failInsert = false;
	const first = await finalizeSent("row-1", w.finalizeIo);
	const again = await finalizeSent("row-1", w.finalizeIo);
	assert.equal(w.msgs.length, 1);
	assert.equal(first?.already, false);
	assert.equal(again?.already, true);
	assert.equal(w.afterCommits.length, 1, "effects after commit only once");
	assert.equal(w.smtpCalls.length, 1);
});

await test("copy already present for (mailbox_id, message_id): merged, neither duplicate nor attachments", async () => {
	const w = world([ledgerRow()]);
	w.msgs.push({ id: "msg-imap", mailboxId: "mb-sent", messageId: "<u-1@example.com>" });
	await runSend("row-1", w.deps);
	assert.equal(w.msgs.length, 1);
	assert.equal(w.ledger.get("row-1")!.sentRowId, "msg-imap");
	assert.deepEqual(w.attachments, []);
	assert.deepEqual(w.afterCommits, [{ messageRowId: "msg-imap", inserted: false }]);
});

await test("two concurrent claims: a single SMTP send", async () => {
	const w = world([ledgerRow()]);
	const [a, b] = await Promise.all([runSend("row-1", w.deps), runSend("row-1", w.deps)]);
	assert.equal(w.smtpCalls.length, 1);
	assert.deepEqual([a.outcome, b.outcome].sort(), ["sent", "skipped"]);
	assert.equal(w.msgs.length, 1);
});

await test("row canceled or already sent: nothing is sent", async () => {
	for (const status of ["canceled", "sent", "failed", "sending"]) {
		const w = world([ledgerRow({ status })]);
		const res = await runSend("row-1", w.deps);
		assert.equal(res.outcome, "skipped", status);
		assert.equal(w.smtpCalls.length, 0, status);
	}
});

await test("render failure (before any SMTP): certain failure, draft marked", async () => {
	const w = world([ledgerRow()]);
	w.deps.render = async () => {
		throw new Error("Attachment not allowed: x.pdf");
	};
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "failed");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "failed");
	assert.equal(row.acceptanceUnknown, false);
	assert.equal(w.smtpCalls.length, 0);
	assert.equal(w.marks.length, 1);
	assert.match(w.marks[0].error, /Attachment not allowed/);
});

await test("server refusal (554): certain failure, Retry without confirmation", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: false, error: "554 5.7.1 rejected", ambiguous: false }) });
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "failed");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "failed");
	assert.equal(row.acceptanceUnknown, false);
	assert.equal(outboxActionsOf(row).confirmRetry, false);
	assert.equal(w.msgs.length, 0);
	assert.match(w.marks[0].error, /554/);
});

await test("refusal without a cause: failure all the same", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: false }) });
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "failed");
	assert.equal(w.msgs.length, 0);
	assert.equal(w.marks.length, 1);
});

await test("unknown outcome (cut after DATA): interrupted, Retry requires confirmation", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: false, error: "Connection closed", ambiguous: true }) });
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "interrupted");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "failed");
	assert.equal(row.acceptanceUnknown, true);
	assert.equal(outboxActionsOf(row).confirmRetry, true);
	assert.equal(w.marks.length, 1);
});

await test("mailer that throws: interrupted (nobody knows where it stopped)", async () => {
	const w = world([ledgerRow()], {
		smtp: () => {
			throw new Error("socket hang up");
		},
	});
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "interrupted");
	assert.equal(w.ledger.get("row-1")!.acceptanceUnknown, true);
});

await test("250 but \"accepted\" UPDATE fails: the row stays sending, never failed", async () => {
	const w = world([ledgerRow()]);
	w.failAccept = true;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "unrecorded");
	assert.equal(w.sleeps.length, ACCEPT_ATTEMPTS - 1);
	assert.equal(w.ledger.get("row-1")!.status, "sending");
	assert.deepEqual(w.marks, []);
	assert.equal(w.msgs.length, 0);
});

await test("250 then transient \"accepted\" UPDATE failure: retried, row sent, SMTP once", async () => {
	const w = world([ledgerRow()]);
	w.failAccept = 2;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	assert.equal(w.ledger.get("row-1")!.status, "sent");
	assert.equal(w.smtpCalls.length, 1);
	assert.equal(w.sleeps.length, 2);
	assert.equal(w.msgs.length, 1);
});

await test("late acceptance after an \"interrupted\" sweep: the row moves to sent", async () => {
	const w = world([ledgerRow()], {
		smtp: (messageId) => {
			// The sweep ran during the SMTP exchange (more than 10 min): interrupted.
			Object.assign(w.ledger.get("row-1")!, { status: "failed", acceptanceUnknown: true });
			return { success: true, MessageId: messageId };
		},
	});
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	assert.equal(w.ledger.get("row-1")!.status, "sent");
});

await test("different Message-ID returned by the provider (SES): it replaces the one of the row", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: true, MessageId: "<0100abc@eu-west-1.amazonses.com>" }) });
	await runSend("row-1", w.deps);
	assert.equal(w.ledger.get("row-1")!.messageId, "<0100abc@eu-west-1.amazonses.com>");
	assert.equal(w.msgs[0].messageId, "<0100abc@eu-west-1.amazonses.com>");
});

await test("row from before the ledger (message_id NULL): Message-ID generated before SMTP", async () => {
	const w = world([ledgerRow({ messageId: null })]);
	await runSend("row-1", w.deps);
	assert.deepEqual(w.smtpCalls, ["<gen-1@example.com>"]);
	assert.equal(w.ledger.get("row-1")!.messageId, "<gen-1@example.com>");
});

// Row from before the ledger (message_id NULL) claimed by the new worker: the sweep only picks up
// rows with a message_id, so the Message-ID is recorded BEFORE SMTP, otherwise a worker that dies
// during the send would leave it "in progress" forever.
await test("row from before the ledger, worker dead during SMTP: Message-ID recorded before, swept as interrupted", async () => {
	const w = world([ledgerRow({ messageId: null })], { smtp: (() => new Promise(() => {})) as any });
	void runSend("row-1", w.deps);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(w.ledger.get("row-1")!.status, "sending");
	assert.equal(w.ledger.get("row-1")!.messageId, "<gen-1@example.com>", "Message-ID recorded before SMTP");
	const res = await sweepLedger(w.deps, new Date(NOW.getTime() + 11 * 60_000));
	assert.deepEqual(res.interrupted, ["row-1"]);
	assert.equal(w.ledger.get("row-1")!.acceptanceUnknown, true);
});

await test("sweep: sending for more than 10 min -> interrupted without resend, mark removed", async () => {
	const old = new Date(NOW.getTime() - 11 * 60_000);
	const recent = new Date(NOW.getTime() - 2 * 60_000);
	const w = world([
		ledgerRow({ id: "stale", status: "sending", updatedAt: old }),
		ledgerRow({ id: "fresh", status: "sending", updatedAt: recent }),
	]);
	const res = await sweepLedger(w.deps, NOW);
	assert.deepEqual(res.interrupted, ["stale"]);
	assert.equal(w.ledger.get("stale")!.status, "failed");
	assert.equal(w.ledger.get("stale")!.acceptanceUnknown, true);
	assert.equal(w.ledger.get("fresh")!.status, "sending");
	assert.equal(w.smtpCalls.length, 0);
	assert.deepEqual(w.marks.map((m) => m.imapDraftId), ["imap-1"]);
});

await test("sweep: accepted more than 2 min ago without a Sent copy -> finalized once", async () => {
	const old = new Date(NOW.getTime() - 3 * 60_000);
	const rendered = { mailboxId: "mb-sent", subject: "Subject" };
	const w = world([
		ledgerRow({ id: "a", status: "sent", acceptedAt: old, rendered }),
		ledgerRow({ id: "b", status: "sent", acceptedAt: NOW, rendered, messageId: "<u-2@x>" }),
		ledgerRow({ id: "c", status: "sent", acceptedAt: old, rendered, deliveryState: "queued", messageId: "<u-3@x>" }),
	]);
	const res = await sweepLedger(w.deps, NOW);
	assert.deepEqual(res.finalized, ["a"]);
	assert.equal(w.msgs.length, 1);
	await sweepLedger(w.deps, NOW);
	assert.equal(w.msgs.length, 1);
});

// Mark left on a draft while its row is finished (crash between the finalizing commit and the
// draft cleanup, failed mark removal or restore): without cleanup, the draft would stay locked
// forever.
await test("sweep: orphan marks -> draft deleted (sent) or unlocked, never a live mark", async () => {
	const old = new Date(NOW.getTime() - 10 * 60_000);
	const owner = "owner-1";
	const draft = (jobId: string) => ({ jobId, ownerId: owner });
	const row = (id: string, over: Partial<WorldRow>) =>
		ledgerRow({ id, updatedAt: old, payload: { draftMessageId: `d-${id}` }, ...over });
	const w = world(
		[
			row("sent", { status: "sent", acceptedAt: old, sentRowId: "msg-9" }),
			row("failed", { status: "failed", lastError: "550 refused" }),
			row("canceled", { status: "canceled" }),
			row("dismissed", { status: "sent", acceptedAt: old, sentRowId: "msg-8", dismissedAt: old, deliveryState: "rejected" }),
			// Accepted, Sent copy still to come: finalizing will delete the draft.
			row("accepted", { status: "sent", acceptedAt: old, sentRowId: null, deliveryState: "queued" }),
			// Too recent: the normal cleanup (finalizing, markFailed) may still run.
			row("recent", { status: "failed", updatedAt: NOW }),
			row("in-progress", { status: "sending", updatedAt: NOW }),
			// The draft carries the mark of a more recent send.
			row("replaced", { status: "failed" }),
		],
		{
			drafts: {
				"d-sent": draft("sent"),
				"d-failed": draft("failed"),
				"d-canceled": draft("canceled"),
				"d-dismissed": draft("dismissed"),
				"d-accepted": draft("accepted"),
				"d-recent": draft("recent"),
				"d-in-progress": draft("in-progress"),
				"d-replaced": draft("other-row"),
			},
		},
	);
	const res = await sweepLedger(w.deps, NOW);
	assert.deepEqual(w.settles, ["sent:delete", "failed:unlock", "canceled:unlock", "dismissed:unlock"]);
	assert.deepEqual(res.settled, ["sent", "failed", "canceled", "dismissed"]);
	assert.equal(w.drafts.has("d-sent"), false);
	assert.equal(w.drafts.get("d-failed")!.jobId, null);
	assert.equal(w.drafts.get("d-accepted")!.jobId, "accepted");
	assert.equal(w.drafts.get("d-recent")!.jobId, "recent");
	assert.equal(w.drafts.get("d-replaced")!.jobId, "other-row");
	// A second sweep finds nothing more; a failed cleanup does not stop the sweep.
	assert.deepEqual((await sweepLedger(w.deps, NOW)).settled, []);
	const w2 = world([row("failed", { status: "failed" })], { drafts: { "d-failed": draft("failed") } });
	w2.failSettle = true;
	assert.deepEqual((await sweepLedger(w2.deps, NOW)).settled, []);
});

await test("legacy send-and-reconcile job: a single ledger row, even when replayed", async () => {
	const inserted: any[] = [];
	const io = {
		findByLegacyKey: async (key: string) => inserted.find((r) => r.payload.__legacyJobKey === key) ?? null,
		insertRow: async (v: any) => {
			const r = { id: `row-${inserted.length + 1}`, ...v };
			inserted.push(r);
			return r;
		},
		newMessageId: () => "<gen-9@x>",
	};
	const job = { id: "42", timestamp: 1_700_000_000_000, data: { sentMailboxId: "mb-sent", identityId: "ident-1", subject: "s" } };
	const first = await legacyLedgerRow(job, { identityId: "ident-1", fromAddress: "a@x" }, io, NOW);
	const again = await legacyLedgerRow(job, { identityId: "ident-1", fromAddress: "a@x" }, io, NOW);
	assert.equal(first, again);
	assert.equal(inserted.length, 1);
	assert.equal(inserted[0].origin, "direct");
	assert.equal(inserted[0].status, "scheduled");
	assert.equal(inserted[0].mailboxId, "mb-sent", "mailboxId = sentMailboxId by default");
	assert.equal(inserted[0].payload.__legacyJobKey, "42:1700000000000");
	assert.equal(inserted[0].messageId, "<gen-9@x>");
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
})();
