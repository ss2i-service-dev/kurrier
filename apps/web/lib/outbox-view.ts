// Outbox, pure part of the interface (see apps/web/test/outbox-view.ts): state labels, place of
// the entry in the sidebar, refresh, and drafts that Drafts leaves to the Outbox. States and
// actions: packages/common/src/outbox-state.ts.
import type { SendState } from "@common/outbox-state";
import type { DraftSendState } from "@common/draft-send";

export function outboxStateLabel(state: SendState): string {
	switch (state) {
		case "pending":
			return "Waiting to be sent";
		case "sending":
			return "Sending";
		case "failed":
			return "Not sent";
		case "interrupted":
			return "Interrupted: may have been sent";
		case "canceled":
			return "Canceled";
		case "delivered":
			return "Sent";
		case "queued":
			return "Queued by the mail server";
		case "canceling":
			return "Canceling";
		case "rejected":
			return "Rejected by the recipient's server";
		case "unknown":
			return "Status unknown";
	}
}

// Calm states (nothing to do); the other visible states are alerts (outboxCountOf).
export const isOutboxCalm = (state: SendState) => state === "pending" || state === "sending" || state === "queued";

// Virtual entry between Drafts and Sent: right after Drafts, otherwise before Sent, otherwise last.
export function outboxSlot(kinds: string[]): number {
	const drafts = kinds.indexOf("drafts");
	if (drafts >= 0) return drafts + 1;
	const sent = kinds.indexOf("sent");
	return sent >= 0 ? sent : kinds.length;
}

// Tracking of an identity for the refresh: sends that move (sending, remote queue) and times of
// the pending sends.
export type OutboxTracking = { busy: number; pendingAt: string[] };

export const OUTBOX_POLL_MS = 10_000;
const COUNTDOWN_MS = 2 * 60_000; // below that, countdown (lib/send-phase.ts, SCHEDULED_AFTER_MS)
const OVERDUE_MS = 3 * 60_000; // beyond that, unknown state (SEND_UNKNOWN_AFTER_MS): no more polling

// Poll every 10 s while a send is leaving or a countdown is running; a scheduled send makes
// nobody poll: a single wake-up 2 minutes before its time.
export function outboxRefreshOf(list: OutboxTracking[], now: number): { poll: boolean; wakeAt: number | null } {
	let poll = false;
	let wakeAt: number | null = null;
	for (const t of list) {
		if (t.busy > 0) poll = true;
		for (const iso of t.pendingAt) {
			const at = Date.parse(iso);
			if (Number.isNaN(at)) continue;
			if (at - now <= COUNTDOWN_MS) {
				if (now - at <= OVERDUE_MS) poll = true;
			} else if (wakeAt === null || at - COUNTDOWN_MS < wakeAt) {
				wakeAt = at - COUNTDOWN_MS;
			}
		}
	}
	return { poll, wakeAt };
}

// A draft only leaves Drafts if its send mark points to a visible Outbox row. Stale mark (row
// canceled or sent, failed restore) or older undo-send-* mark: it stays in Drafts with its badge,
// never missing from both lists.
export function inOutbox(draftSend: DraftSendState | null | undefined, outboxIds: ReadonlySet<string>): boolean {
	const jobId = draftSend?.pendingSend?.jobId;
	return !!jobId && outboxIds.has(String(jobId));
}
