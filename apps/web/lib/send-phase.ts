// Phase of a tracked send (pendingSend mark of a draft), pure part of
// components/mailbox/default/draft-send-status.tsx (testable without React, see
// apps/web/test/schedule-send.ts).
import { formatScheduledWhen } from "../../../packages/common/src/schedule-send";

// A send whose time is more than 3 minutes past while the draft is still there has an unknown
// state: no endless refreshing.
export const SEND_UNKNOWN_AFTER_MS = 3 * 60_000;
export const SEND_REFRESH_MS = 3_000;
// Beyond 2 minutes of waiting, the send is "scheduled" (time shown, no one-second countdown nor
// refresh every 3 s); below, it is the countdown of the undo delay (60 s at most).
export const SCHEDULED_AFTER_MS = 2 * 60_000;

export type SendPhase = "scheduled" | "countdown" | "sending" | "unknown";

export function sendPhaseOf(sendAt: string, now: number): SendPhase {
	const at = new Date(sendAt).getTime();
	if (Number.isNaN(at) || now - at > SEND_UNKNOWN_AFTER_MS) return "unknown";
	if (at - now > SCHEDULED_AFTER_MS) return "scheduled";
	return at > now ? "countdown" : "sending";
}

// Tracking of a set of sends: `fast` = at least one countdown or send in progress (1 s clock,
// refresh every 3 s); `wakeAt` = moment the first scheduled send enters the countdown (a single
// refresh, no tick until then), null otherwise.
export function sendTrackingOf(
	sendAts: (string | null | undefined)[],
	now: number,
): { fast: boolean; wakeAt: number | null } {
	let fast = false;
	let wakeAt: number | null = null;
	for (const sendAt of sendAts) {
		if (!sendAt) continue;
		const phase = sendPhaseOf(sendAt, now);
		if (phase === "countdown" || phase === "sending") fast = true;
		if (phase === "scheduled") {
			const at = new Date(sendAt).getTime() - SCHEDULED_AFTER_MS;
			if (wakeAt === null || at < wakeAt) wakeAt = at;
		}
	}
	return { fast, wakeAt };
}

export function sendLabel(
	sendAt: string,
	now: number,
	// Display time zone: undefined = the environment's; null = not known yet (server render,
	// before mount: the time is shown only once the browser's time zone is read).
	tz?: string | null,
	// "24-hour time" option (pref24HourTime).
	hour24 = false,
	locale?: string,
) {
	const phase = sendPhaseOf(sendAt, now);
	if (phase === "unknown") return "Sending status unknown";
	if (phase === "sending") return "Sending…";
	if (phase === "scheduled") {
		if (tz === null) return "Scheduled";
		return `Scheduled for ${formatScheduledWhen(new Date(sendAt), tz ?? undefined, new Date(now), hour24, locale)}`;
	}
	const s = Math.max(1, Math.ceil((new Date(sendAt).getTime() - now) / 1000));
	return `Sending in ${s}s`;
}
