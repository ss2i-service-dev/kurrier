"use client";
import type { DraftSendState } from "@common";
import type { DraftTimes } from "@common/draft-send";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { cancelPendingSend, sendPendingNow } from "@/lib/actions/mailbox";
import { useModernUi } from "@/components/k/ui-context";

// Send state of a draft (pendingSend / sendError marks of meta.draft). A send whose time
// passed more than 3 minutes ago while the draft is still there has an unknown state: we
// stop refreshing indefinitely.
export const SEND_UNKNOWN_AFTER_MS = 3 * 60_000;
export const SEND_REFRESH_MS = 3_000;

export type SendPhase = "countdown" | "sending" | "unknown";

export function sendPhaseOf(sendAt: string, now: number): SendPhase {
	const at = new Date(sendAt).getTime();
	if (Number.isNaN(at) || now - at > SEND_UNKNOWN_AFTER_MS) return "unknown";
	return at > now ? "countdown" : "sending";
}

// Local clock (1 s) while the send is in progress.
export function useNow(active: boolean) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	return now;
}

// Refreshes the page (router.refresh) every 3 s while a send is tracked.
export function useSendRefresh(active: boolean) {
	const router = useRouter();
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => router.refresh(), SEND_REFRESH_MS);
		return () => clearInterval(t);
	}, [active, router]);
}

// True if any of the given states is a send that is still tracked (not an unknown state).
export function anySendTracked(states: (DraftSendState | null | undefined)[], now = Date.now()) {
	return states.some(
		(s) => s?.pendingSend && sendPhaseOf(s.pendingSend.sendAt, now) !== "unknown",
	);
}

export function sendLabel(sendAt: string, now: number) {
	const phase = sendPhaseOf(sendAt, now);
	if (phase === "unknown") return "Sending status unknown";
	if (phase === "sending") return "Sending…";
	const s = Math.max(1, Math.ceil((new Date(sendAt).getTime() - now) / 1000));
	return `Sending in ${s}s`;
}

// "Undo" / "Send now" buttons; onUndone runs after an undo, then the page is refreshed.
export function SendActions({
	jobId,
	onUndone,
	size = "sm",
}: {
	jobId: string;
	onUndone?: () => void;
	size?: "xs" | "sm";
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
	const pending = state?.pendingSend ?? null;
	const now = useNow(!!pending);
	if (pending) {
		const phase = sendPhaseOf(pending.sendAt, now);
		return (
			<span className="inline-flex shrink-0 items-center gap-1.5">
				<span className={`inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs font-semibold ${modern ? "rounded-k-sm bg-k-accent-soft text-k-accent-soft-ink" : "rounded bg-sky-600 text-white"}`}>
					<IconSend size={12} aria-hidden />
					{sendLabel(pending.sendAt, now)}
				</span>
				{phase !== "unknown" && <SendActions jobId={pending.jobId} size="xs" />}
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
	const now = useNow(true);
	const phase = sendPhaseOf(pendingSend.sendAt, now);
	useSendRefresh(phase !== "unknown");
	return (
		<div className={`mt-3 border p-4 text-sm ${modern ? "rounded-k border-k-line-strong bg-k-warn-soft text-k-ink" : "rounded-lg border-amber-300 bg-amber-50 text-amber-900"}`}>
			<div className="font-medium">
				{phase === "unknown"
					? "Sending status unknown"
					: "This message is being sent"}
			</div>
			<div className="mt-1 text-xs">
				{phase === "unknown"
					? "No result was received for this send. Check the Sent folder before sending again."
					: sendLabel(pendingSend.sendAt, now)}
			</div>
			<div className="mt-3">
				{phase !== "unknown" ? (
					<SendActions jobId={pendingSend.jobId} onUndone={onUndone} />
				) : (
					<button
						type="button"
						className={modern ? "k-focus rounded-k-sm border border-k-line-strong bg-k-surface px-3 py-1 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink" : "rounded border px-3 py-1 text-sm hover:bg-amber-100"}
						onClick={onOpenEditor}
					>
						Open editor
					</button>
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
