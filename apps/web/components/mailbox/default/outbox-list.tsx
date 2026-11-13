"use client";
// ss2i : Boite d'envoi (OI 10519). Envois en attente (delai d'annulation, heure programmee), en
// cours et en echec, lus sur le ledger draft_messages (fetchOutbox) ; actions selon l'etat de la
// ligne (outboxActionsOf). Interface classique en anglais, nouvelle interface en francais, heures
// en 24 h. Partie pure : lib/outbox-view.ts.
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
import { useK, useNouvelle } from "@/components/k/ui-context";
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

// Actualise la page (barre laterale et liste) toutes les 10 s tant qu'un envoi part ou qu'un
// decompte court, et une fois 2 minutes avant un envoi programme ; rien sinon.
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
		// setTimeout plafonne a ~24 jours : au-dela, on se reveille puis on se re-arme.
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
	const k = useK();
	const nouvelle = useNouvelle();
	const router = useRouter();
	const tz = useLocalTz();
	const pendingAt = item.state === "pending" ? item.scheduledAt : null;
	const now = useSendClock(pendingAt);
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const alert = !isOutboxCalm(item.state);
	const status = pendingAt ? sendLabel(pendingAt, now, k, tz) : outboxStateLabel(item.state, k);
	const when = !pendingAt && tz !== null ? formatScheduledWhen(new Date(item.updatedAt), nouvelle ? "fr" : "en", tz) : "";

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
				const state = res.state ? outboxStateLabel(res.state, k) : k("no longer waiting", "plus en attente");
				toast.error(k(`Too late to cancel: ${state}`, `Trop tard pour annuler : ${state}`));
			}
		});
	const sendNow = () => run(async () => void (await sendPendingNow(item.id)));
	const retry = (confirmed: boolean) =>
		run(async () => {
			const res = await retryOutboxSend(item.id, { confirmed });
			if (res.needsConfirm) return setConfirming(true);
			setConfirming(false);
			if (!res.ok) toast.error(res.error ?? k("Could not send again", "Nouvel essai impossible"));
		});
	const dismiss = () =>
		run(async () => {
			const res = await dismissOutboxSend(item.id);
			if (!res.ok) toast.error(res.error ?? k("Could not move back to drafts", "Remise en brouillon impossible"));
		});

	const btn = nouvelle
		? "k-focus rounded-k-sm border border-k-line-strong bg-k-surface px-2 py-0.5 text-xs text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink disabled:opacity-50"
		: "rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50";
	const a = item.actions;

	return (
		<li
			className={
				nouvelle
					? "flex items-start gap-3 rounded-k px-3 py-2.5 transition-colors hover:bg-k-hover"
					: "flex items-start gap-3 px-3 py-2 transition-colors hover:bg-muted/50"
			}
		>
			<div className="min-w-0 flex-1">
				<div className={nouvelle ? "truncate text-[13.5px] font-semibold text-k-ink" : "truncate font-semibold"}>
					{k("To: ", "À : ")}
					{toLabel(item.to, k("No recipients", "Aucun destinataire"))}
				</div>
				<div className={nouvelle ? "truncate text-[13px] text-k-ink-2" : "truncate text-sm text-muted-foreground"}>
					{item.subject || k("(no subject)", "(sans objet)")}
				</div>
				<div
					className={`mt-1 flex items-center gap-1.5 text-xs ${
						alert ? "font-semibold text-red-600 dark:text-red-400" : nouvelle ? "text-k-accent" : "text-sky-700 dark:text-sky-300"
					}`}
				>
					{alert ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Clock className="h-3.5 w-3.5 shrink-0" />}
					<span className="whitespace-nowrap">
						{status}
						{when && ` · ${when}`}
					</span>
				</div>
				{alert && item.error && (
					<div className={`mt-0.5 truncate text-xs ${nouvelle ? "text-k-ink-3" : "text-muted-foreground"}`} title={item.error}>
						{item.error}
					</div>
				)}
				{confirming && (
					<div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
						<span className="font-semibold text-red-600 dark:text-red-400">
							{k("This message may already have been sent. Send it again anyway?", "Ce mail est peut-être déjà parti. Le renvoyer quand même ?")}
						</span>
						<button type="button" disabled={busy} className={btn} onClick={() => retry(true)}>
							{k("Send again", "Renvoyer")}
						</button>
						<button type="button" disabled={busy} className={btn} onClick={() => setConfirming(false)}>
							{k("Don't send", "Ne pas renvoyer")}
						</button>
					</div>
				)}
			</div>
			<div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
				{a.cancel && (
					<button type="button" disabled={busy} className={btn} onClick={cancel}>
						{k("Cancel sending", "Annuler l'envoi")}
					</button>
				)}
				{a.sendNow && (
					<button type="button" disabled={busy} className={btn} onClick={sendNow}>
						{k("Send now", "Envoyer maintenant")}
					</button>
				)}
				{a.retry && !confirming && (
					<button type="button" disabled={busy} className={btn} onClick={() => (a.confirmRetry ? setConfirming(true) : retry(false))}>
						{k("Retry", "Réessayer")}
					</button>
				)}
				{a.dismiss && (dismissRestoresDraft(item.origin) ? (
					<button
						type="button"
						disabled={busy}
						className={btn}
						onClick={dismiss}
						title={k("Remove from the Outbox; the message stays in Drafts", "Retirer de la boîte d'envoi ; le message reste dans les brouillons")}
					>
						{k("Back to drafts", "Remettre en brouillon")}
					</button>
				) : (
					<button
						type="button"
						disabled={busy}
						className={btn}
						onClick={dismiss}
						title={k("Remove from the Outbox (this message had no draft)", "Retirer de la boîte d'envoi (ce message n'avait pas de brouillon)")}
					>
						{k("Dismiss", "Écarter")}
					</button>
				))}
			</div>
		</li>
	);
}

export default function OutboxList({ items }: { items: OutboxItem[] }) {
	const nouvelle = useNouvelle();
	if (nouvelle) {
		if (items.length === 0) {
			return (
				<KEmptyState
					icon={<Inbox size={22} strokeWidth={1.6} />}
					title="Rien en attente d'envoi"
					text="Les messages en cours d'envoi, programmés ou qui ne sont pas partis restent ici jusqu'à leur départ."
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
