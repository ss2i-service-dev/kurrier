// Outbox. Send pipeline of the worker, arbitrated by the draft_messages ledger row (one row per
// send). Pure: database, SMTP, S3 and IMAP are injected (the Drizzle wiring is in
// server/plugins/send-mail.ts, the tests in test/send-accept-finalize.ts).
//
// Order, and why:
//  1. claim: CAS scheduled -> sending; lost (canceled, already taken), nothing is sent.
//  2. render (identity, secrets, attachments, quote) outside any transaction, without writes.
//  3. SMTP with the Message-ID of the row, outside any transaction.
//  4. a single "accepted" UPDATE (sent, accepted_at, smtp_response, rendered). After a 250,
//     nothing writes "failed" any more: a mail that left is never offered for resending. If this
//     UPDATE fails, the row stays "sending" and the sweep marks it "interrupted".
//  5. finalizeSent: idempotent Sent copy (transaction, locked row, sent_row_id), then effects
//     after the commit (S3 eml, search, contacts, draft deletion).
// Never an automatic resend: a resend after a lost 250 sends the mail twice.
import type { SendEmailResult } from "../../../../packages/providers/src/core";
import { mailerFailureOf } from "../send-outcome";
import { settleActionOf, type SettleAction } from "../../../../packages/common/src/draft-send";

export type LedgerRow = {
	id: string;
	status: string;
	payload: Record<string, any>;
	identityId: string | null;
	messageId: string | null;
	acceptedAt: Date | null;
	acceptanceUnknown: boolean;
	deliveryState: string;
	rendered: Record<string, any> | null;
	sentRowId: string | null;
	updatedAt: Date;
};

// Each method is a single UPDATE ... WHERE <expected state> RETURNING (null = transition lost).
export type LedgerStore = {
	get(id: string): Promise<LedgerRow | null>;
	// scheduled -> sending
	claim(id: string): Promise<LedgerRow | null>;
	// sending -> failed (last_error, acceptance_unknown, payload.__error for the older readers)
	fail(id: string, f: { error: string; ambiguous: boolean }): Promise<LedgerRow | null>;
	// sending, or interrupted and never accepted (sweep ran during the SMTP exchange) -> sent
	accept(
		id: string,
		a: { messageId: string; smtpResponse: string | null; rendered: Record<string, any> },
	): Promise<LedgerRow | null>;
	// sending without accepted_at, with message_id, not touched since `before`
	staleSending(before: Date): Promise<LedgerRow[]>;
	// Claimed row from before the ledger: message_id set before SMTP (sending, message_id NULL)
	setMessageId(id: string, messageId: string): Promise<LedgerRow | null>;
	// sent, accepted_at before `before`, delivery_state none, sent_row_id NULL
	unfinalized(before: Date): Promise<LedgerRow[]>;
	// Drafts whose send mark points to a row neither scheduled nor sending, touched between
	// `since` and `before` (join messages -> draft_messages through the mark).
	orphanMarks(before: Date, since: Date): Promise<OrphanMark[]>;
};

export type OrphanMark = {
	rowId: string;
	status: string;
	acceptedAt: Date | null;
	sentRowId: string | null;
	dismissedAt: Date | null;
	acceptanceUnknown: boolean;
	lastError: string | null;
	identityId: string | null;
	draftId: string;
	ownerId: string;
};

// Rendered message, ready to leave: `rendered` is frozen on the row at acceptance (finalizing is
// replayed from the row, even after a worker restart).
export type Prepared = {
	from: string;
	imapDraftId: string | null;
	rendered: Record<string, any>;
	send: (messageId: string) => Promise<SendEmailResult>;
};

export type SendDeps = {
	store: LedgerStore;
	render: (row: LedgerRow) => Promise<Prepared>;
	newMessageId: (from: string) => string;
	finalize: (rowId: string) => Promise<unknown>;
	// Failed end of a send on the draft: pendingSend mark removed, sendError set.
	markFailed: (row: LedgerRow, error: string) => Promise<unknown>;
	// Cleanup of an orphan mark (settleActionOf): draft deleted or mark removed, in both cases only
	// if the mark still points to the row.
	settleDraft?: (o: OrphanMark, action: SettleAction) => Promise<unknown>;
	// Wait between two attempts of the "accepted" UPDATE (injectable for the tests).
	sleep?: (ms: number) => Promise<unknown>;
	log?: (msg: string, err?: unknown) => void;
};

// After a 250, the "accepted" UPDATE is retried (transient database outage): without it the row
// stays sending and the sweep would declare it interrupted although the mail left.
export const ACCEPT_ATTEMPTS = 3;
export const ACCEPT_RETRY_MS = 500;

export type SendOutcome =
	| { outcome: "skipped"; row: LedgerRow | null }
	| { outcome: "failed" | "interrupted"; error: string; row: LedgerRow | null }
	| { outcome: "sent"; row: LedgerRow }
	| { outcome: "unrecorded"; error: string };

const messageOf = (err: unknown) => String((err as any)?.message ?? err);

// Message-ID of an HTTP provider (SES <...@amazonses.com>, SendGrid x-message-id): replaces the
// one of the row if it differs, otherwise the threading of replies breaks.
const providerMessageId = (res: SendEmailResult, ours: string) => {
	const theirs = String(res.MessageId ?? "").trim();
	if (!theirs || theirs === ours) return ours;
	return theirs.startsWith("<") ? theirs : `<${theirs}>`;
};

async function failRow(deps: SendDeps, row: LedgerRow, error: string, ambiguous: boolean): Promise<SendOutcome> {
	const log = deps.log ?? console.error;
	let failed: LedgerRow | null = null;
	try {
		failed = await deps.store.fail(row.id, { error, ambiguous });
		if (!failed) log(`[send] ${row.id}: failure not recorded (row already out of sending)`);
		await deps.markFailed(failed ?? { ...row, acceptanceUnknown: ambiguous }, error);
	} catch (err) {
		log(`[send] ${row.id}: could not record the failure`, err);
	}
	return { outcome: ambiguous ? "interrupted" : "failed", error, row: failed };
}

export async function runSend(rowId: string, deps: SendDeps): Promise<SendOutcome> {
	const log = deps.log ?? console.error;
	const row = await deps.store.claim(rowId);
	if (!row) return { outcome: "skipped", row: await deps.store.get(rowId) };

	let prepared: Prepared;
	try {
		prepared = await deps.render(row);
	} catch (err) {
		// Before any SMTP: certain failure.
		return failRow(deps, row, messageOf(err), false);
	}

	const messageId = row.messageId || deps.newMessageId(prepared.from);
	if (!row.messageId) {
		// Row from before the ledger: Message-ID recorded before SMTP, otherwise the sweep (which
		// only picks up rows with a message_id) would never see a send cut off here.
		try {
			if (!(await deps.store.setMessageId(row.id, messageId))) {
				return { outcome: "skipped", row: await deps.store.get(rowId) };
			}
		} catch (err) {
			return failRow(deps, row, messageOf(err), false);
		}
	}
	let res: SendEmailResult;
	try {
		res = await prepared.send(messageId);
	} catch (err) {
		// The mailer threw without returning an outcome: nobody knows where it stopped.
		res = { success: false, error: messageOf(err), ambiguous: true };
	}
	if (!res.success) {
		return failRow(deps, row, mailerFailureOf(res) as string, !!res.ambiguous);
	}

	// Accepted by the server: from here on, never "failed" again.
	let accepted: LedgerRow | null = null;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	for (let attempt = 1; ; attempt++) {
		try {
			accepted = await deps.store.accept(row.id, {
				messageId: providerMessageId(res, messageId),
				smtpResponse: res.response ?? null,
				rendered: prepared.rendered,
			});
			break;
		} catch (err) {
			if (attempt >= ACCEPT_ATTEMPTS) {
				log(`[send] ${row.id}: accepted by the server but not recorded`, err);
				return { outcome: "unrecorded", error: messageOf(err) };
			}
			log(`[send] ${row.id}: recording the acceptance, attempt ${attempt} failed`, err);
			await sleep(ACCEPT_RETRY_MS * attempt);
		}
	}
	if (!accepted) {
		log(`[send] ${row.id}: accepted by the server but the row changed state`);
		return { outcome: "unrecorded", error: "row changed state" };
	}
	try {
		await deps.finalize(row.id);
	} catch (err) {
		// The sweep takes over finalizing (accepted_at set, sent_row_id NULL).
		log(`[send] ${row.id}: Sent copy postponed`, err);
	}
	return { outcome: "sent", row: accepted };
}

export type FinalizeTx = {
	// SELECT ... FOR UPDATE of the ledger row
	lockRow(id: string): Promise<LedgerRow | null>;
	// Thread of the reply or forward (rendered.threadId), otherwise a new thread
	ensureThread(row: LedgerRow): Promise<string>;
	// INSERT messages ... ON CONFLICT (mailbox_id, message_id) DO NOTHING, otherwise the existing row
	insertMessage(row: LedgerRow, threadId: string): Promise<{ id: string; inserted: boolean }>;
	insertAttachments(messageRowId: string, row: LedgerRow): Promise<unknown>;
	upsertThreadItem(messageRowId: string): Promise<unknown>;
	setSentRowId(rowId: string, messageRowId: string): Promise<unknown>;
};

export type FinalizeIo = {
	transaction<T>(fn: (tx: FinalizeTx) => Promise<T>): Promise<T>;
	// Non-transactional effects, once, after the commit; a loss here (crash between the commit and
	// the effect) is not replayed: known limit.
	afterCommit(f: { row: LedgerRow; messageRowId: string; inserted: boolean }): Promise<unknown>;
};

export type FinalizeResult = { messageRowId: string; inserted: boolean; already: boolean } | null;

// Sent copy of an accepted row, idempotent: replayed (sweep, double call), it never creates a
// second messages row; an IMAP copy that arrived first is taken over as is.
export async function finalizeSent(rowId: string, io: FinalizeIo, log = console.error): Promise<FinalizeResult> {
	const done = await io.transaction(async (tx) => {
		const row = await tx.lockRow(rowId);
		if (!row || row.status !== "sent" || !row.rendered || !row.messageId) return null;
		if (row.sentRowId) return { row, messageRowId: row.sentRowId, inserted: false, already: true };
		const threadId = await tx.ensureThread(row);
		const { id, inserted } = await tx.insertMessage(row, threadId);
		if (inserted) await tx.insertAttachments(id, row);
		await tx.upsertThreadItem(id);
		await tx.setSentRowId(row.id, id);
		return { row, messageRowId: id, inserted, already: false };
	});
	if (!done) return null;
	if (!done.already) {
		await io
			.afterCommit({ row: done.row, messageRowId: done.messageRowId, inserted: done.inserted })
			.catch((err) => log(`[send] ${rowId}: effects after send`, err));
	}
	return { messageRowId: done.messageRowId, inserted: done.inserted, already: done.already };
}

export const STALE_SENDING_MS = 10 * 60_000;
export const FINALIZE_GRACE_MS = 2 * 60_000;
export const INTERRUPTED_ERROR =
	"Sending interrupted before the server answered: this message may already have been sent";

// Orphan marks looked up on rows finished within 7 days (beyond that, pendingSendLive no longer
// counts them as a lock).
export const ORPHAN_WINDOW_MS = 7 * 24 * 3600_000;

// Sweep (worker startup, then every 5 minutes): a send left "sending" for more than 10 minutes
// without acceptance -> interrupted (never resent); a send accepted more than 2 minutes ago
// without a Sent copy -> finalized; a draft whose mark points to a row finished more than
// 2 minutes ago -> deleted (sent) or unlocked.
export async function sweepLedger(
	deps: Pick<SendDeps, "store" | "finalize" | "markFailed" | "settleDraft" | "log">,
	now: Date = new Date(),
): Promise<{ interrupted: string[]; finalized: string[]; settled: string[] }> {
	const log = deps.log ?? console.error;
	const interrupted: string[] = [];
	const finalized: string[] = [];
	const settled: string[] = [];
	for (const row of await deps.store.staleSending(new Date(now.getTime() - STALE_SENDING_MS))) {
		try {
			const failed = await deps.store.fail(row.id, { error: INTERRUPTED_ERROR, ambiguous: true });
			if (!failed) continue;
			interrupted.push(row.id);
			await deps.markFailed(failed, INTERRUPTED_ERROR);
		} catch (err) {
			log(`[send] sweep ${row.id}`, err);
		}
	}
	for (const row of await deps.store.unfinalized(new Date(now.getTime() - FINALIZE_GRACE_MS))) {
		try {
			await deps.finalize(row.id);
			finalized.push(row.id);
		} catch (err) {
			log(`[send] finalisation ${row.id}`, err);
		}
	}
	if (deps.settleDraft) {
		const before = new Date(now.getTime() - FINALIZE_GRACE_MS);
		const since = new Date(now.getTime() - ORPHAN_WINDOW_MS);
		for (const o of await deps.store.orphanMarks(before, since)) {
			const action = settleActionOf(o);
			if (!action) continue;
			try {
				await deps.settleDraft(o, action);
				settled.push(o.rowId);
			} catch (err) {
				log(`[send] draft cleanup ${o.draftId} (row ${o.rowId})`, err);
			}
		}
	}
	return { interrupted, finalized, settled };
}

// Legacy "send-and-reconcile" job (in flight at deploy time, older web, unsubscribe, invitations,
// API): it gets its ledger row (direct origin) then goes through runSend. The key
// job.id:timestamp makes the creation idempotent if the job is replayed (stalled).
export async function legacyLedgerRow(
	job: { id?: string | null; timestamp: number; data: Record<string, any> },
	ident: { identityId: string; fromAddress: string },
	io: {
		findByLegacyKey(key: string): Promise<{ id: string } | null>;
		insertRow(v: {
			payload: Record<string, any>;
			identityId: string;
			mailboxId: string;
			status: "scheduled";
			origin: "direct";
			messageId: string;
			scheduledAt: Date;
		}): Promise<{ id: string }>;
		newMessageId(from: string): string;
	},
	now: Date = new Date(),
): Promise<string> {
	const key = `${job.id}:${job.timestamp}`;
	const existing = await io.findByLegacyKey(key);
	if (existing) return existing.id;
	const created = await io.insertRow({
		payload: { ...job.data, __legacyJobKey: key },
		identityId: ident.identityId,
		mailboxId: String(job.data.mailboxId || job.data.sentMailboxId || ""),
		status: "scheduled",
		origin: "direct",
		messageId: io.newMessageId(ident.fromAddress),
		scheduledAt: now,
	});
	return created.id;
}
