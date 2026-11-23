// Outbox. One draft_messages row per send (ledger); the displayed state, the visibility in the
// Outbox, the counter and the possible actions are computed here, and only here. Pure (no
// database, no Redis): importable client-side (see apps/web/test/outbox.ts).
//
// status keeps its meaning (sent = accepted by the SMTP server); delivery_state carries what
// follows (remote queue, not tracked yet): none, queued, canceling, delivered, rejected, unknown.

export type SendState =
	| "pending" // waiting: undo delay or scheduled time
	| "sending" // being sent (claimed by the worker)
	| "failed" // certain refusal by the server
	| "interrupted" // unknown outcome: may have been sent
	| "canceled"
	| "delivered" // delivered (accepted by SMTP, or proof of delivery from the remote queue)
	| "queued" // in the remote queue (not tracked yet)
	| "canceling" // queued cancel requested (not tracked yet)
	| "rejected" // refused after the queue (not tracked yet)
	| "unknown"; // neither queue nor log (not tracked yet)

export type LedgerStateRow = {
	status: string;
	deliveryState?: string | null;
	acceptanceUnknown?: boolean | null;
	acceptedAt?: Date | string | null;
	dismissedAt?: Date | string | null;
	sentRowId?: string | null;
};

export function sendStateOf(row: LedgerStateRow): SendState | null {
	switch (row.status) {
		case "scheduled":
			return "pending";
		case "sending":
			return "sending";
		case "failed":
			return row.acceptanceUnknown ? "interrupted" : "failed";
		case "canceled":
			return "canceled";
		case "sent":
			switch (row.deliveryState) {
				case "queued":
					return "queued";
				case "canceling":
					return "canceling";
				case "rejected":
					return "rejected";
				case "unknown":
					return "unknown";
				default:
					return "delivered";
			}
		default:
			return null;
	}
}

// In progress: always visible. Failures: visible until the user dismisses them (dismissed_at).
// Delivered and canceled: never.
const ALWAYS_VISIBLE: SendState[] = ["pending", "sending", "queued", "canceling", "unknown"];
const VISIBLE_UNTIL_DISMISSED: SendState[] = ["failed", "interrupted", "rejected"];
// "Normal" states of the counter; any other visible state turns it into an alert (red).
const CALM: SendState[] = ["pending", "sending", "queued"];

export function isOutboxVisible(row: LedgerStateRow): boolean {
	const state = sendStateOf(row);
	if (!state) return false;
	if (ALWAYS_VISIBLE.includes(state)) return true;
	return VISIBLE_UNTIL_DISMISSED.includes(state) && !row.dismissedAt;
}

export type OutboxCount = { total: number; alert: number };

export function outboxCountOf(rows: LedgerStateRow[]): OutboxCount {
	let total = 0;
	let alert = 0;
	for (const row of rows) {
		if (!isOutboxVisible(row)) continue;
		total++;
		if (!CALM.includes(sendStateOf(row)!)) alert++;
	}
	return { total, alert };
}

export type OutboxActions = {
	cancel: boolean; // Cancel sending (CAS scheduled -> canceled)
	sendNow: boolean; // Envoyer maintenant
	retry: boolean; // Retry (CAS failed -> scheduled), never after acceptance
	confirmRetry: boolean; // "this message may already have been sent" before retrying
	dismiss: boolean; // Back to drafts (dismissed from the Outbox)
};

// "Back to drafts": only a send that came from a draft (undo delay, scheduled) recreates one;
// a direct send (API, unsubscribe, invitation) is only dismissed.
export function dismissRestoresDraft(origin: string | null | undefined): boolean {
	return origin === "undo" || origin === "scheduled";
}

export function outboxActionsOf(row: LedgerStateRow): OutboxActions {
	const state = sendStateOf(row);
	const pending = state === "pending";
	const failed = state === "failed" || state === "interrupted";
	return {
		cancel: pending,
		sendNow: pending,
		retry: failed && !row.acceptedAt,
		confirmRetry: state === "interrupted" && !row.acceptedAt,
		dismiss: failed || state === "rejected",
	};
}
