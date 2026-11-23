"use client";
import type { DraftSendState } from "@common";
import type { DraftTimes } from "@common/draft-send";
import { useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { isScheduledMark } from "@common/draft-send";
import { cancelPendingSend, sendPendingNow } from "@/lib/actions/mailbox";
import { useHour24, useModernUi } from "@/components/k/ui-context";
import { SEND_REFRESH_MS, sendLabel, sendPhaseOf, sendTrackingOf } from "@/lib/send-phase";

// Send state of a draft (pendingSend / sendError marks of meta.draft). Phases and labels live
// in lib/send-phase.ts (pure, tested): "scheduled" beyond 2 minutes of waiting, a countdown
// below, "unknown" once the send time is more than 3 minutes past.
export {
	SCHEDULED_AFTER_MS,
	SEND_REFRESH_MS,
	SEND_UNKNOWN_AFTER_MS,
	sendLabel,
	sendPhaseOf,
	sendTrackingOf,
	type SendPhase,
} from "@/lib/send-phase";

// Time zone of the browser, read after mount (null before: the server render and the first
// client render are identical).
export function useLocalTz() {
	const [tz, setTz] = useState<string | null>(null);
	useEffect(() => setTz(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
	return tz;
}

// Clock of a tracked send: a one-second tick during the countdown and the send; nothing while
// it is scheduled (a single wake-up when the countdown starts) nor when the state is unknown.
export function useSendClock(sendAt: string | null | undefined) {
	const [now, setNow] = useState(() => Date.now());
	const [wakes, setWakes] = useState(0);
	const phase = sendAt ? sendPhaseOf(sendAt, now) : "unknown";
	useEffect(() => {
		if (!sendAt || phase === "unknown") return;
		setNow(Date.now());
		if (phase === "scheduled") {
			// setTimeout is capped at ~24 days: beyond that, wake up and re-arm.
			const wait = Math.min(
				Math.max(0, (sendTrackingOf([sendAt], Date.now()).wakeAt ?? Date.now()) - Date.now()) + 50,
				2 ** 31 - 1,
			);
			const t = setTimeout(() => {
				setNow(Date.now());
				setWakes((n) => n + 1);
			}, wait);
			return () => clearTimeout(t);
		}
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [sendAt, phase, wakes]);
	return now;
}

// Refreshes the page (router.refresh) every 3 s while a countdown or a send is tracked
// (`active`), and once when a scheduled send enters its countdown (`wakeAt`). A scheduled
// send triggers no periodic refresh.
export function useSendRefresh(active: boolean, wakeAt: number | null = null) {
	const router = useRouter();
	const [wakes, setWakes] = useState(0);
	// Wake-up already handled: a re-arm (wakes) does not refresh twice for the same moment.
	const firedFor = useRef<number | null>(null);
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => router.refresh(), SEND_REFRESH_MS);
		return () => clearInterval(t);
	}, [active, router]);
	useEffect(() => {
		if (wakeAt === null || firedFor.current === wakeAt) return;
		const wait = Math.min(Math.max(0, wakeAt - Date.now()) + 50, 2 ** 31 - 1);
		const t = setTimeout(() => {
			if (Date.now() >= wakeAt) {
				firedFor.current = wakeAt;
				router.refresh();
			}
			setWakes((n) => n + 1);
		}, wait);
		return () => clearTimeout(t);
	}, [wakeAt, router, wakes]);
}

// Tracking of a list of drafts: fast refresh and wake-up of scheduled sends.
export function useSendListRefresh(states: (DraftSendState | null | undefined)[]) {
	const { fast, wakeAt } = sendTrackingOf(states.map((s) => s?.pendingSend?.sendAt), Date.now());
	useSendRefresh(fast, wakeAt);
}

// "Undo" / "Send now" buttons; onUndone runs after an undo, then the page is refreshed.
export function SendActions({
	jobId,
	onUndone,
	size = "sm",
	cancelOnly = false,
}: {
	jobId: string;
	onUndone?: () => void;
	size?: "xs" | "sm";
	// Unknown state of a scheduled send: only cancelling is offered.
	cancelOnly?: boolean;
}) {
	const modern = useModernUi();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const cls = modern
		? `k-focus rounded-k-sm border border-k-line-strong bg-k-surface text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink disabled:opacity-50 ${size === "xs" ? "px-1.5 py-0.5 text-xs" : "px-3 py-1 text-[13px]"}`
		: size === "xs"
			? "rounded border px-1.5 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
			: "rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50";
	return (
		<span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
			<button
				type="button"
				disabled={busy}
				className={cls}
				onClick={async () => {
					setBusy(true);
					await cancelPendingSend(jobId);
					setBusy(false);
					onUndone?.();
					router.refresh();
				}}
			>
				Undo
			</button>
			{!cancelOnly && (
				<button
					type="button"
					disabled={busy}
					className={cls}
					onClick={async () => {
						setBusy(true);
						await sendPendingNow(jobId);
						setBusy(false);
						router.refresh();
					}}
				>
					Send now
				</button>
			)}
		</span>
	);
}

// A draft whose send was requested is no longer a draft: it is leaving (or has left, state
// unknown). The Drafts list sets it apart (Outbox) and the counter ignores it.
export const isSendingDraft = (state: DraftSendState | null | undefined) =>
	!!state?.pendingSend;

// Badge for a row of the Drafts list.
export function DraftSendBadge({ state }: { state: DraftSendState | null | undefined }) {
	const modern = useModernUi();
	const hour24 = useHour24();
	const pending = state?.pendingSend ?? null;
	const now = useSendClock(pending?.sendAt);
	const tz = useLocalTz();
	if (pending) {
		const phase = sendPhaseOf(pending.sendAt, now);
		return (
			<span className="inline-flex shrink-0 items-center gap-1.5">
				<span className={`inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs font-semibold ${modern ? "rounded-k-sm bg-k-accent-soft text-k-accent-soft-ink" : "rounded bg-sky-600 text-white"}`}>
					<IconSend size={12} aria-hidden />
					{sendLabel(pending.sendAt, now, tz, hour24)}
				</span>
				{(phase !== "unknown" || isScheduledMark(pending)) && (
					<SendActions jobId={pending.jobId} size="xs" cancelOnly={phase === "unknown"} />
				)}
			</span>
		);
	}
	if (state?.sendError) {
		return (
			<span
				className={`whitespace-nowrap px-1.5 py-0.5 text-xs font-medium ${modern ? "rounded-k-sm bg-k-danger-soft text-k-danger" : "rounded bg-red-100 text-red-700"}`}
				title={state.sendError.message}
			>
				Not sent
			</span>
		);
	}
	return null;
}

// Shown instead of the editor when opening a draft that is being sent.
export function DraftSendingBanner({
	pendingSend,
	onUndone,
	onOpenEditor,
}: {
	pendingSend: { jobId: string; sendAt: string };
	onUndone: () => void;
	// Unknown state: the user can still reopen the editor.
	onOpenEditor: () => void;
}) {
	const modern = useModernUi();
	const hour24 = useHour24();
	const now = useSendClock(pendingSend.sendAt);
	const tz = useLocalTz();
	const phase = sendPhaseOf(pendingSend.sendAt, now);
	const tracking = sendTrackingOf([pendingSend.sendAt], now);
	useSendRefresh(tracking.fast, tracking.wakeAt);
	return (
		<div className={`mt-3 border p-4 text-sm ${modern ? "rounded-k border-k-line-strong bg-k-warn-soft text-k-ink" : "rounded-lg border-amber-300 bg-amber-50 text-amber-900"}`}>
			<div className="font-medium">
				{phase === "unknown"
					? "Sending status unknown"
					: phase === "scheduled"
						? "This message is scheduled"
						: "This message is being sent"}
			</div>
			<div className="mt-1 text-xs">
				{phase === "unknown"
					? "No result was received for this send. Check the Sent folder before sending again."
					: sendLabel(pendingSend.sendAt, now, tz, hour24)}
			</div>
			<div className="mt-3">
				{phase !== "unknown" ? (
					<SendActions jobId={pendingSend.jobId} onUndone={onUndone} />
				) : (
					<span className="inline-flex flex-wrap items-center gap-2">
						{/* Scheduled send in an unknown state: the row may still be "scheduled". */}
						{isScheduledMark(pendingSend) && (
							<SendActions jobId={pendingSend.jobId} onUndone={onUndone} cancelOnly />
						)}
						<button
							type="button"
							className={modern ? "k-focus rounded-k-sm border border-k-line-strong bg-k-surface px-3 py-1 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink" : "rounded border px-3 py-1 text-sm hover:bg-amber-100"}
							onClick={onOpenEditor}
						>
							Open editor
						</button>
					</span>
				)}
			</div>
		</div>
	);
}

// Time (today) or date and time of a draft timestamp.
export function draftStamp(iso: string, now = new Date()) {
	const d = new Date(iso);
	const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === now.toDateString()) return time;
	const day = d.toLocaleDateString(undefined, {
		day: "2-digit",
		month: "2-digit",
		...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
	});
	return `${day} ${time}`;
}

// Creation and last edit of a draft, in the Drafts list and the editor.
export function DraftTimesLabel({
	times,
	className = "",
}: {
	times: DraftTimes | null | undefined;
	className?: string;
}) {
	if (!times?.createdAt) return null;
	const created = draftStamp(times.createdAt);
	const edited =
		times.savedAt && Math.abs(new Date(times.savedAt).getTime() - new Date(times.createdAt).getTime()) >= 60_000
			? draftStamp(times.savedAt)
			: null;
	const full = (iso: string) => new Date(iso).toLocaleString();
	return (
		<span
			className={`shrink-0 whitespace-nowrap tabular-nums ${className}`}
			title={`Created ${full(times.createdAt)}${times.savedAt ? ` · last edited ${full(times.savedAt)}` : ""}`}
		>
			Created {created}
			{edited ? ` · edited ${edited}` : ""}
		</span>
	);
}
