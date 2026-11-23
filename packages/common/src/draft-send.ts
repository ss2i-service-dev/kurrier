// Send state of a draft (meta.draft.pendingSend / sendError), the pure part of
// drafts.ts (testable without a database, see apps/worker/test/draft-send.ts).

export type DraftPendingSend = { jobId: string; sendAt: string };
export type DraftSendError = { message: string; at: string };

export type DraftSendFields = {
	pendingSend?: DraftPendingSend;
	sendError?: DraftSendError;
	quoteMode?: unknown;
	quoteHtml?: unknown;
};

// Merge of meta.draft on save: the send state (pendingSend) is kept as-is by an autosave
// update and is only changed by setDraftSendState. An edit after a failed send clears
// sendError (the error message is stale).
export function mergeDraftMeta<M extends DraftSendFields>(
	prev: M | null,
	next: M,
): M {
	const merged = {
		...(prev ?? {}),
		quoteMode: undefined,
		quoteHtml: undefined,
		...next,
	} as M;
	delete merged.sendError;
	if (prev?.pendingSend) merged.pendingSend = prev.pendingSend;
	else delete merged.pendingSend;
	return merged;
}

// Send state of a draft, as read by the list and when opening it.
export type DraftSendState = {
	pendingSend: DraftPendingSend | null;
	sendError: DraftSendError | null;
};

export const draftSendStateOf = (
	meta: DraftSendFields | null | undefined,
): DraftSendState => ({
	pendingSend: meta?.pendingSend ?? null,
	sendError: meta?.sendError ?? null,
});

export type DraftTimes = { createdAt: string | null; savedAt: string | null };

// Creation and last-edit times of a draft. Drafts older than meta.draft.createdAt, or
// coming from another client over IMAP, take the creation time of the row.
export function draftTimesOf(row: {
	metaData: Record<string, any> | null;
	createdAt?: Date | string | null;
	updatedAt?: Date | string | null;
	date?: Date | string | null;
}): DraftTimes {
	const meta = (row.metaData as any)?.draft ?? null;
	const iso = (v: Date | string | null | undefined) =>
		v == null ? null : v instanceof Date ? v.toISOString() : String(v);
	const createdAt = meta?.createdAt ?? iso(row.createdAt) ?? iso(row.date);
	const savedAt = meta?.savedAt ?? iso(row.updatedAt) ?? iso(row.date) ?? createdAt;
	return { createdAt, savedAt };
}

// "Pending send" guard. A draft whose send is pending (undo delay or scheduled send) is not
// silently changed or deleted: the send carries a copy of the content, a change would be lost
// without the user knowing.
export const DRAFT_PENDING_ERROR = "This draft is scheduled; cancel the scheduled send first";
// Previous send interrupted, or cut off after sending (the server did not answer): the mail
// may have been sent, the draft does not leave again until the send is dismissed in the
// Outbox ("Retry" asks for confirmation there).
export const DRAFT_MAYBE_SENT_ERROR = "This message may already have been sent: check the Outbox";

// Error set on the draft at the end of a failed send.
export function draftSendErrorOf(row: { acceptanceUnknown?: boolean | null }, error: string | null | undefined): string {
	if (!row.acceptanceUnknown) return String(error ?? "");
	return error ? `${DRAFT_MAYBE_SENT_ERROR}. ${error}` : DRAFT_MAYBE_SENT_ERROR;
}

// Undo countdown with no outcome for 3 minutes: unknown state, the mark no longer locks.
export const PENDING_STALE_MS = 3 * 60_000;

// A scheduled send has the draft_messages row as jobId; an undo countdown, "undo-send-<uuid>".
export const isScheduledMark = (pending: DraftPendingSend | null | undefined) =>
	!!pending?.jobId && !pending.jobId.startsWith("undo-send-");

// draft_messages ledger row a mark points to (jobId = row id).
export type MarkLedgerRow = {
	status: string;
	acceptedAt?: Date | string | null;
	sentRowId?: string | null;
	dismissedAt?: Date | string | null;
};

// The row keeps the draft locked: send waiting, in progress, or accepted without a Sent copy
// yet (finalizing then deletes the draft).
const rowHoldsDraft = (row: MarkLedgerRow) =>
	!row.dismissedAt &&
	(row.status === "scheduled" ||
		row.status === "sending" ||
		(row.status === "sent" && !!row.acceptedAt && !row.sentRowId));

// Orphan mark (finished row, draft not cleaned up: crash after the commit, failed cleanup,
// restore or mark removal): sent with its Sent copy -> the draft goes; failure, cancel,
// dismissed row or legacy "sent" row -> only the mark is removed, the content stays. Null: the
// row still holds the draft.
export type SettleAction = "delete" | "unlock";
export function settleActionOf(row: MarkLedgerRow): SettleAction | null {
	if (rowHoldsDraft(row)) return null;
	return row.status === "sent" && row.sentRowId && !row.dismissedAt ? "delete" : "unlock";
}

// `row`: row a scheduled send mark points to (undefined = not read, null = missing).
export function pendingSendAlive(
	pending: DraftPendingSend | null | undefined,
	now: number = Date.now(),
	row?: MarkLedgerRow | null,
): boolean {
	if (!pending) return false;
	const at = Date.parse(pending.sendAt);
	if (Number.isNaN(at)) return false;
	// A scheduled send stays alive as long as its row does (the time may be past if the worker
	// is stopped); a finished or missing row no longer locks the draft.
	if (isScheduledMark(pending)) return row === undefined || (!!row && rowHoldsDraft(row));
	return at > now - PENDING_STALE_MS;
}
