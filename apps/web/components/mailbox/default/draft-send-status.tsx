"use client";
import type { DraftSendState } from "@common";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { cancelPendingSend, sendPendingNow } from "@/lib/actions/mailbox";

// ss2i : etat d'envoi d'un brouillon (marque pendingSend / sendError de meta.draft).
// Un envoi dont l'heure est depassee de plus de 3 minutes sans que le brouillon ait
// disparu est d'etat inconnu : on n'actualise plus indefiniment.
export const SEND_UNKNOWN_AFTER_MS = 3 * 60_000;
export const SEND_REFRESH_MS = 3_000;

export type SendPhase = "countdown" | "sending" | "unknown";

export function sendPhaseOf(sendAt: string, now: number): SendPhase {
	const at = new Date(sendAt).getTime();
	if (Number.isNaN(at) || now - at > SEND_UNKNOWN_AFTER_MS) return "unknown";
	return at > now ? "countdown" : "sending";
}

// Horloge locale (1 s) tant que l'envoi est en cours.
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

// Actualise la page (router.refresh) toutes les 3 s tant qu'un envoi est suivi.
export function useSendRefresh(active: boolean) {
	const router = useRouter();
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => router.refresh(), SEND_REFRESH_MS);
		return () => clearInterval(t);
	}, [active, router]);
}

// Vrai si l'un des etats donnes est un envoi encore suivi (pas d'etat inconnu).
export function anySendTracked(states: (DraftSendState | null | undefined)[], now = Date.now()) {
	return states.some(
		(s) => s?.pendingSend && sendPhaseOf(s.pendingSend.sendAt, now) !== "unknown",
	);
}

export function sendLabel(sendAt: string, now: number) {
	const phase = sendPhaseOf(sendAt, now);
	if (phase === "unknown") return "Sending status unknown";
	if (phase === "sending") return "Sending…";
	return `Sending in ${Math.max(1, Math.ceil((new Date(sendAt).getTime() - now) / 1000))}s`;
}

// Boutons « Undo » / « Send now » ; onDone apres l'action (rafraichissement de la page).
export function SendActions({
	jobId,
	onUndone,
	size = "sm",
}: {
	jobId: string;
	onUndone?: () => void;
	size?: "xs" | "sm";
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const cls =
		size === "xs"
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

// ss2i : un brouillon dont l'envoi a ete demande n'est plus un brouillon : il part (ou est
// parti, etat inconnu). La liste Drafts le range a part (Outbox), le compteur l'ignore.
export const isSendingDraft = (state: DraftSendState | null | undefined) =>
	!!state?.pendingSend;

// Badge d'une ligne de la liste Drafts.
export function DraftSendBadge({ state }: { state: DraftSendState | null | undefined }) {
	const pending = state?.pendingSend ?? null;
	const now = useNow(!!pending);
	if (pending) {
		const phase = sendPhaseOf(pending.sendAt, now);
		return (
			<span className="inline-flex shrink-0 items-center gap-1.5">
				<span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-sky-600 px-1.5 py-0.5 text-xs font-semibold text-white">
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
				className="whitespace-nowrap rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700"
				title={state.sendError.message}
			>
				Not sent
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
	const now = useNow(true);
	const phase = sendPhaseOf(pendingSend.sendAt, now);
	useSendRefresh(phase !== "unknown");
	return (
		<div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
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
						className="rounded border px-3 py-1 text-sm hover:bg-amber-100"
						onClick={onOpenEditor}
					>
						Open editor
					</button>
				)}
			</div>
		</div>
	);
}
