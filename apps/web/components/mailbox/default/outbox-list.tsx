"use client";
// Outbox: sends that are waiting (undo delay, scheduled time), in progress or failed, read from
// the draft_messages ledger (fetchOutbox); actions according to the state of the row
// (outboxActionsOf). Times follow the "24-hour time" option. Pure part: lib/outbox-view.ts.
import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Clock, Inbox } from "lucide-react";
import { formatScheduledWhen } from "@common/schedule-send";
import { dismissRestoresDraft } from "@common/outbox-state";
import {
	cancelPendingSend,
	dismissOutboxSend,
	retryOutboxSend,
	sendPendingNow,
	type OutboxItem,
} from "@/lib/actions/mailbox";
import { useHour24, useModernUi } from "@/components/k/ui-context";
import { KEmptyState } from "@/components/k/section";
import { useLocalTz, useSendClock } from "@/components/mailbox/default/draft-send-status";
import { sendLabel } from "@/lib/send-phase";
import {
	isOutboxCalm,
	OUTBOX_POLL_MS,
	outboxRefreshOf,
	outboxStateLabel,
	type OutboxTracking,
} from "@/lib/outbox-view";

// Refreshes the page (sidebar and list) every 10 s while a send is leaving or a countdown is
// running, and once 2 minutes before a scheduled send; nothing otherwise.
export function useOutboxRefresh(list: OutboxTracking[]) {
	const router = useRouter();
	const [wakes, setWakes] = useState(0);
	const { poll, wakeAt } = outboxRefreshOf(list, Date.now());
	useEffect(() => {
		if (!poll) return;
		const t = setInterval(() => router.refresh(), OUTBOX_POLL_MS);
		return () => clearInterval(t);
	}, [poll, router]);
	useEffect(() => {
		if (wakeAt === null) return;
		// setTimeout is capped at ~24 days: beyond that, wake up and re-arm.
		const wait = Math.min(Math.max(0, wakeAt - Date.now()) + 50, 2 ** 31 - 1);
		const t = setTimeout(() => {
			if (Date.now() >= wakeAt) router.refresh();
			setWakes((n) => n + 1);
		}, wait);
		return () => clearTimeout(t);
	}, [wakeAt, router, wakes]);
}

const toLabel = (to: string[], none: string) =>
	to.length === 0 ? none : to.slice(0, 3).join(", ") + (to.length > 3 ? "…" : "");

function OutboxRow({ item }: { item: OutboxItem }) {
	const modern = useModernUi();
	const hour24 = useHour24();
	const router = useRouter();
	const tz = useLocalTz();
	const pendingAt = item.state === "pending" ? item.scheduledAt : null;
	const now = useSendClock(pendingAt);
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const alert = !isOutboxCalm(item.state);
	const status = pendingAt ? sendLabel(pendingAt, now, tz, hour24) : outboxStateLabel(item.state);
	const when = !pendingAt && tz !== null ? formatScheduledWhen(new Date(item.updatedAt), tz, new Date(now), hour24) : "";

	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		try {
			await fn();
		} catch (err: any) {
			toast.error(String(err?.message ?? err));
		} finally {
			setBusy(false);
			router.refresh();
		}
	};
	const cancel = () =>
		run(async () => {
			const res = await cancelPendingSend(item.id);
			if (!res.cancelled) {
				const state = res.state ? outboxStateLabel(res.state) : "no longer waiting";
				toast.error(`Too late to cancel: ${state}`);
			}
		});
	const sendNow = () => run(async () => void (await sendPendingNow(item.id)));
	const retry = (confirmed: boolean) =>
		run(async () => {
			const res = await retryOutboxSend(item.id, { confirmed });
			if (res.needsConfirm) return setConfirming(true);
			setConfirming(false);
			if (!res.ok) toast.error(res.error ?? "Could not send again");
		});
	const dismiss = () =>
		run(async () => {
			const res = await dismissOutboxSend(item.id);
			if (!res.ok) toast.error(res.error ?? "Could not move back to drafts");
		});

	const btn = modern
		? "k-focus rounded-k-sm border border-k-line-strong bg-k-surface px-2 py-0.5 text-xs text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink disabled:opacity-50"
		: "rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50";
	const a = item.actions;

	return (
		<li
			className={
				modern
					? "flex items-start gap-3 rounded-k px-3 py-2.5 transition-colors hover:bg-k-hover"
					: "flex items-start gap-3 px-3 py-2 transition-colors hover:bg-muted/50"
			}
		>
			<div className="min-w-0 flex-1">
				<div className={modern ? "truncate text-[13.5px] font-semibold text-k-ink" : "truncate font-semibold"}>
					To: {toLabel(item.to, "No recipients")}
				</div>
				<div className={modern ? "truncate text-[13px] text-k-ink-2" : "truncate text-sm text-muted-foreground"}>
					{item.subject || "(no subject)"}
				</div>
				<div
					className={`mt-1 flex items-center gap-1.5 text-xs ${
						alert ? "font-semibold text-red-600 dark:text-red-400" : modern ? "text-k-accent" : "text-sky-700 dark:text-sky-300"
					}`}
				>
					{alert ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Clock className="h-3.5 w-3.5 shrink-0" />}
					<span className="whitespace-nowrap">
						{status}
						{when && ` · ${when}`}
					</span>
				</div>
				{alert && item.error && (
					<div className={`mt-0.5 truncate text-xs ${modern ? "text-k-ink-3" : "text-muted-foreground"}`} title={item.error}>
						{item.error}
					</div>
				)}
				{confirming && (
					<div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
						<span className="font-semibold text-red-600 dark:text-red-400">
							This message may already have been sent. Send it again anyway?
						</span>
						<button type="button" disabled={busy} className={btn} onClick={() => retry(true)}>
							Send again
						</button>
						<button type="button" disabled={busy} className={btn} onClick={() => setConfirming(false)}>
							Don&apos;t send
						</button>
					</div>
				)}
			</div>
			<div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
				{a.cancel && (
					<button type="button" disabled={busy} className={btn} onClick={cancel}>
						Cancel sending
					</button>
				)}
				{a.sendNow && (
					<button type="button" disabled={busy} className={btn} onClick={sendNow}>
						Send now
					</button>
				)}
				{a.retry && !confirming && (
					<button type="button" disabled={busy} className={btn} onClick={() => (a.confirmRetry ? setConfirming(true) : retry(false))}>
						Retry
					</button>
				)}
				{a.dismiss && (dismissRestoresDraft(item.origin) ? (
					<button
						type="button"
						disabled={busy}
						className={btn}
						onClick={dismiss}
						title="Remove from the Outbox; the message stays in Drafts"
					>
						Back to drafts
					</button>
				) : (
					<button
						type="button"
						disabled={busy}
						className={btn}
						onClick={dismiss}
						title="Remove from the Outbox (this message had no draft)"
					>
						Dismiss
					</button>
				))}
			</div>
		</li>
	);
}

export default function OutboxList({ items }: { items: OutboxItem[] }) {
	const modern = useModernUi();
	if (modern) {
		if (items.length === 0) {
			return (
				<KEmptyState
					icon={<Inbox size={22} strokeWidth={1.6} />}
					title="Nothing waiting to be sent"
					text="Messages being sent, scheduled or not sent stay here until they leave."
				/>
			);
		}
		return (
			<ul role="list" className="space-y-px px-1.5 pb-2">
				{items.map((item) => (
					<OutboxRow key={item.id} item={item} />
				))}
			</ul>
		);
	}

	if (items.length === 0) {
		return <div className="p-4 text-center text-base text-muted-foreground">Nothing waiting to be sent</div>;
	}
	return (
		<div className="rounded-xl border bg-background/50">
			<div className="flex items-center justify-between border-b px-3 py-2">
				<div className="text-sm font-semibold">Outbox</div>
				<div className="text-xs text-muted-foreground">{items.length}</div>
			</div>
			<ul role="list" className="divide-y">
				{items.map((item) => (
					<OutboxRow key={item.id} item={item} />
				))}
			</ul>
		</div>
	);
}
