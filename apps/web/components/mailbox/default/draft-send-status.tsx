"use client";
import type { DraftSendState } from "@common";
import type { DraftTimes } from "@common/draft-send";
import { useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { toast } from "sonner";
import { isScheduledMark } from "@common/draft-send";
import { cancelPendingSend, sendPendingNow } from "@/lib/actions/mailbox";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { SEND_REFRESH_MS, sendLabel, sendPhaseOf, sendTrackingOf } from "@/lib/send-phase";

// ss2i : etat d'envoi d'un brouillon (marque pendingSend / sendError de meta.draft). Phases et
// libelles dans lib/send-phase.ts (partie pure, testee) : « programme » au-dela de 2 minutes
// d'attente, decompte en dessous, « inconnu » apres 3 minutes de depassement.
export {
	SCHEDULED_AFTER_MS,
	SEND_REFRESH_MS,
	SEND_UNKNOWN_AFTER_MS,
	sendLabel,
	sendPhaseOf,
	sendTrackingOf,
	type SendPhase,
} from "@/lib/send-phase";

// Fuseau du navigateur, lu apres le montage (null avant : le rendu serveur et le premier rendu
// client sont identiques).
export function useLocalTz() {
	const [tz, setTz] = useState<string | null>(null);
	useEffect(() => setTz(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
	return tz;
}

// Horloge d'un envoi suivi : tic d'une seconde pendant le decompte et l'envoi ; rien tant
// qu'il est programme (un seul reveil quand le decompte commence) ni quand l'etat est inconnu.
export function useSendClock(sendAt: string | null | undefined) {
	const [now, setNow] = useState(() => Date.now());
	const [wakes, setWakes] = useState(0);
	const phase = sendAt ? sendPhaseOf(sendAt, now) : "unknown";
	useEffect(() => {
		if (!sendAt || phase === "unknown") return;
		setNow(Date.now());
		if (phase === "scheduled") {
			// setTimeout plafonne a ~24 jours : au-dela, on se reveille puis on se re-arme.
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

// Actualise la page (router.refresh) toutes les 3 s tant qu'un decompte ou un envoi est suivi
// (`active`), et une fois au passage d'un envoi programme au decompte (`wakeAt`). Un envoi
// programme ne declenche aucune actualisation periodique.
export function useSendRefresh(active: boolean, wakeAt: number | null = null) {
	const router = useRouter();
	const [wakes, setWakes] = useState(0);
	// Reveil deja traite : un re-armement (wakes) ne rafraichit pas deux fois pour le meme instant.
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

// Suivi d'une liste de brouillons : actualisation rapide et reveil des envois programmes.
export function useSendListRefresh(states: (DraftSendState | null | undefined)[]) {
	const { fast, wakeAt } = sendTrackingOf(states.map((s) => s?.pendingSend?.sendAt), Date.now());
	useSendRefresh(fast, wakeAt);
}

// Boutons « Undo » / « Send now » ; onDone apres l'action (rafraichissement de la page).
export function SendActions({
	jobId,
	onUndone,
	size = "sm",
	cancelOnly = false,
}: {
	jobId: string;
	onUndone?: () => void;
	size?: "xs" | "sm";
	// Etat inconnu d'un envoi programme : seule l'annulation reste proposee.
	cancelOnly?: boolean;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const cls = nouvelle
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
				{k("Undo", "Annuler l'envoi")}
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
					{k("Send now", "Envoyer maintenant")}
				</button>
			)}
		</span>
	);
}

// ss2i : un brouillon dont l'envoi a ete demande n'est plus un brouillon : il part (ou est
// parti, etat inconnu). La liste Drafts le range a part (Outbox), le compteur l'ignore.
export const isSendingDraft = (state: DraftSendState | null | undefined) =>
	!!state?.pendingSend;

// Badge d'une ligne de la liste Drafts.
export function DraftSendBadge({ state }: { state: DraftSendState | null | undefined }) {
	const k = useK();
	const nouvelle = useNouvelle();
	const pending = state?.pendingSend ?? null;
	const now = useSendClock(pending?.sendAt);
	const tz = useLocalTz();
	if (pending) {
		const phase = sendPhaseOf(pending.sendAt, now);
		return (
			<span className="inline-flex shrink-0 items-center gap-1.5">
				<span className={`inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs font-semibold ${nouvelle ? "rounded-k-sm bg-k-accent-soft text-k-accent-soft-ink" : "rounded bg-sky-600 text-white"}`}>
					<IconSend size={12} aria-hidden />
					{sendLabel(pending.sendAt, now, k, tz)}
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
				className={`whitespace-nowrap px-1.5 py-0.5 text-xs font-medium ${nouvelle ? "rounded-k-sm bg-k-danger-soft text-k-danger" : "rounded bg-red-100 text-red-700"}`}
				title={state.sendError.message}
			>
				{k("Not sent", "Non envoyé")}
			</span>
		);
	}
	return null;
}

// Ouverture d'un brouillon en cours d'envoi : a la place de l'editeur.
export function DraftSendingBanner({
	pendingSend,
	onUndone,
	onOpenEditor,
}: {
	pendingSend: { jobId: string; sendAt: string };
	onUndone: () => void;
	// Etat inconnu : l'utilisateur peut quand meme rouvrir l'editeur.
	onOpenEditor: () => void;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const now = useSendClock(pendingSend.sendAt);
	const tz = useLocalTz();
	const phase = sendPhaseOf(pendingSend.sendAt, now);
	const tracking = sendTrackingOf([pendingSend.sendAt], now);
	useSendRefresh(tracking.fast, tracking.wakeAt);
	return (
		<div className={`mt-3 border p-4 text-sm ${nouvelle ? "rounded-k border-k-line-strong bg-k-warn-soft text-k-ink" : "rounded-lg border-amber-300 bg-amber-50 text-amber-900"}`}>
			<div className="font-medium">
				{phase === "unknown"
					? k("Sending status unknown", "État d'envoi inconnu")
					: phase === "scheduled"
						? k("This message is scheduled", "Ce message est programmé")
						: k("This message is being sent", "Ce message est en cours d'envoi")}
			</div>
			<div className="mt-1 text-xs">
				{phase === "unknown"
					? k(
							"No result was received for this send. Check the Sent folder before sending again.",
							"Aucun résultat n'a été reçu pour cet envoi. Vérifiez le dossier Envoyés avant de renvoyer.",
						)
					: sendLabel(pendingSend.sendAt, now, k, tz)}
			</div>
			<div className="mt-3">
				{phase !== "unknown" ? (
					<SendActions jobId={pendingSend.jobId} onUndone={onUndone} />
				) : (
					<span className="inline-flex flex-wrap items-center gap-2">
						{/* Envoi programme d'etat inconnu : la ligne est peut-etre encore « scheduled ». */}
						{isScheduledMark(pendingSend) && (
							<SendActions jobId={pendingSend.jobId} onUndone={onUndone} cancelOnly />
						)}
						<button
							type="button"
							className={nouvelle ? "k-focus rounded-k-sm border border-k-line-strong bg-k-surface px-3 py-1 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink" : "rounded border px-3 py-1 text-sm hover:bg-amber-100"}
							onClick={onOpenEditor}
						>
							{k("Open editor", "Ouvrir l'éditeur")}
						</button>
					</span>
				)}
			</div>
		</div>
	);
}

// ss2i : heure (aujourd'hui) ou date et heure d'un horodatage de brouillon.
export function draftStamp(iso: string, now = new Date()) {
	const d = new Date(iso);
	const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === now.toDateString()) return time;
	const day = d.toLocaleDateString("fr-FR", {
		day: "2-digit",
		month: "2-digit",
		...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
	});
	return `${day} ${time}`;
}

// ss2i : creation et derniere edition d'un brouillon, dans la liste Drafts et l'editeur.
export function DraftTimesLabel({
	times,
	className = "",
}: {
	times: DraftTimes | null | undefined;
	className?: string;
}) {
	const k = useK();
	if (!times?.createdAt) return null;
	const created = draftStamp(times.createdAt);
	const edited =
		times.savedAt && Math.abs(new Date(times.savedAt).getTime() - new Date(times.createdAt).getTime()) >= 60_000
			? draftStamp(times.savedAt)
			: null;
	const full = (iso: string) => new Date(iso).toLocaleString("fr-FR");
	return (
		<span
			className={`shrink-0 whitespace-nowrap tabular-nums ${className}`}
			title={`${k("Created", "Créé le")} ${full(times.createdAt)}${times.savedAt ? ` · ${k("last edited", "dernière modification le")} ${full(times.savedAt)}` : ""}`}
		>
			{k("Created", "Créé")} {created}
			{edited ? ` · ${k("edited", "modifié")} ${edited}` : ""}
		</span>
	);
}
