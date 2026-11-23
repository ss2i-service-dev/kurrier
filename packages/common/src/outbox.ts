// Outbox. Queuing and canceling a send, arbitrated by the draft_messages ledger row (one row
// per send). Pure: the database, Redis and IMAP are passed as parameters (see
// apps/web/test/outbox-cancel.ts), used by the web interface and the worker.
import { scheduledJobOf } from "./schedule-send";
import { sendStateOf, type LedgerStateRow, type SendState } from "./outbox-state";
import { DRAFT_MAYBE_SENT_ERROR, settleActionOf, type SettleAction } from "./draft-send";

// Origin of a send: undo delay, scheduled send, immediate send (API, unsubscribe link,
// invitation).
export type SendOrigin = "undo" | "scheduled" | "direct";

// Message-ID set before SMTP, in the nodemailer format (<uuid@sender domain>, "localhost"
// without a domain): it ties the row, the accepted message and the Sent copy together, and
// makes recovery after a crash idempotent.
export function messageIdFor(fromAddress: string | null | undefined, uuid: string): string {
	const raw = String(fromAddress ?? "");
	const bracketed = raw.match(/<([^>]*)>/)?.[1] ?? raw;
	const domain = bracketed.split("@")[1]?.trim().toLowerCase().replace(/[>\s].*$/, "");
	return `<${uuid}@${domain || "localhost"}>`;
}

export type EnqueueInput = {
	payload: Record<string, any>;
	identityId: string;
	mailboxId: string;
	origin: SendOrigin;
	sendAt: Date;
	fromAddress: string | null | undefined;
};

export type EnqueueRowValues = {
	payload: Record<string, any>;
	identityId: string;
	mailboxId: string;
	status: "scheduled";
	origin: SendOrigin;
	messageId: string;
	scheduledAt: Date;
};

export type EnqueueIo = {
	uuid?: () => string;
	insertRow: (v: EnqueueRowValues) => Promise<{ id: string; scheduledAt: Date | string | null }>;
	addJob: (name: string, data: Record<string, any>, opts: Record<string, any>) => Promise<unknown>;
	deleteRow: (id: string) => Promise<unknown>;
	// Row without a job that could not be removed: set to canceled (UPDATE ... WHERE status =
	// 'scheduled'), otherwise it would stay scheduled for nothing.
	cancelRow?: (id: string) => Promise<unknown>;
	// Send mark of the draft (pendingSend, jobId = row), set BEFORE the job: the worker only
	// removes it afterwards (a failed immediate send does not see it set again). False = no send.
	mark?: (row: { id: string; scheduledAt: Date }) => Promise<boolean>;
	// Mark removed when the job could not be added.
	unmark?: () => Promise<unknown>;
	// Dismisses the previous failures of the same draft (a new send replaces them), never an
	// interrupted send.
	supersede?: (imapDraftId: string) => Promise<unknown>;
	// Does the draft have an interrupted send not dismissed (failed, acceptance_unknown, never accepted)?
	interrupted?: (imapDraftId: string) => Promise<boolean>;
};

export type EnqueueResult =
	| { ok: true; rowId: string; messageId: string; scheduledAt: Date }
	| { ok: false; error: string; maybeSent?: boolean };

// Scheduled row first, then the draft mark, then the job with the same id. BullMQ never replays
// the job (a resend after a lost 250 sends twice): no attempts. Without a job, the row is
// removed. A draft whose previous send was interrupted (may have been sent) does not leave
// again: explicit refusal before any row, to be settled in the Outbox.
export async function enqueueSend(input: EnqueueInput, io: EnqueueIo, now: Date = new Date()): Promise<EnqueueResult> {
	const draftId = input.payload?.draftMessageId;
	if (draftId && io.interrupted && (await io.interrupted(String(draftId)))) {
		return { ok: false, error: DRAFT_MAYBE_SENT_ERROR, maybeSent: true };
	}
	const uuid = io.uuid ?? (() => globalThis.crypto.randomUUID());
	const messageId = messageIdFor(input.fromAddress, uuid());
	const row = await io.insertRow({
		payload: input.payload,
		identityId: input.identityId,
		mailboxId: input.mailboxId,
		status: "scheduled",
		origin: input.origin,
		messageId,
		scheduledAt: input.sendAt,
	});
	const scheduledAt = new Date(row.scheduledAt ?? input.sendAt);
	const dropRow = () =>
		io.deleteRow(row.id).catch(async (e) => {
			console.error("[outbox] row without a job not removed", row.id, e);
			if (io.cancelRow) await io.cancelRow(row.id).catch((e2) => console.error("[outbox] row without a job not canceled", row.id, e2));
		});
	if (io.mark && !(await io.mark({ id: row.id, scheduledAt }).catch(() => false))) {
		await dropRow();
		return { ok: false, error: "draft send mark could not be set" };
	}
	const job = scheduledJobOf(
		{ id: row.id, identityId: input.identityId, scheduledAt, payload: input.payload },
		now.getTime(),
	);
	try {
		await io.addJob(job.name, job.data, job.opts);
	} catch (err: any) {
		await dropRow();
		if (io.unmark) await io.unmark().catch((e) => console.error("[outbox] mark not removed", row.id, e));
		return { ok: false, error: String(err?.message ?? err) };
	}
	if (draftId && io.supersede) {
		await io.supersede(String(draftId)).catch((e) => console.error("[outbox] supersede", draftId, e));
	}
	return { ok: true, rowId: row.id, messageId, scheduledAt };
}

// "Send now": the ledger row decides (`rowStatus` null = no visible row, send from before the
// ledger). Waiting job -> promoted; job missing or finished (failed, completed: BullMQ keeps the
// id, an add with the same id would be ignored, it is removed first) while the row is still
// scheduled -> added again from the row; row out of scheduled or job already running -> nothing.
export type SendNowPlan = "promote" | "readd" | "none";
export function sendNowPlanOf(jobState: string | null, rowStatus: string | null): SendNowPlan {
	if (rowStatus !== null && rowStatus !== "scheduled") return "none";
	if (jobState === "delayed") return "promote";
	const gone = jobState === null || jobState === "unknown" || jobState === "failed" || jobState === "completed";
	return rowStatus === "scheduled" && gone ? "readd" : "none";
}

export type CancelIo = {
	// UPDATE draft_messages SET status = 'canceled' WHERE id = ? AND status = 'scheduled' RETURNING
	casCancel: () => Promise<unknown | null>;
	readRow: () => Promise<LedgerStateRow | null>;
	removeJob: () => Promise<unknown>;
	// Row content put back into the draft, send mark removed (CAS won only).
	restore: () => Promise<unknown>;
	// Row already canceled: only removes the draft send mark if it still points to this row (a
	// previous failed restore left it), without touching the content.
	unlock?: () => Promise<unknown>;
	// Row finished while the draft still carries its mark (settleActionOf): draft deleted if the
	// send left with its Sent copy, only the mark removed otherwise; in both cases only if the
	// mark still points to this row.
	settle?: (action: SettleAction) => Promise<unknown>;
};

export type CancelResult = { cancelled: boolean; state: SendState | null };

// Cancel: the CAS scheduled -> canceled comes first. Won, the job is removed then the draft
// restored; their failures do not undo the cancel (the worker only claims a scheduled row).
// Already canceled (second click, stale tab): job removed and mark removed, never a restore
// (the row content would overwrite a draft changed since). Lost, nothing is restored and the
// real state is returned; a finished row puts the draft back in order.
export async function cancelSend(io: CancelIo): Promise<CancelResult> {
	const won = await io.casCancel();
	if (!won) {
		const row = await io.readRow();
		if (!row || row.status !== "canceled") {
			const action = row ? settleActionOf(row) : null;
			if (action && io.settle) await io.settle(action).catch((e) => console.error("[outbox] draft cleanup", e));
			return { cancelled: false, state: row ? sendStateOf(row) : null };
		}
	}
	await io.removeJob().catch((e) => console.error("[outbox] job removal", e));
	if (won) await io.restore().catch((e) => console.error("[outbox] draft restore", e));
	else if (io.unlock) await io.unlock().catch((e) => console.error("[outbox] draft unlock", e));
	return { cancelled: true, state: "canceled" };
}
