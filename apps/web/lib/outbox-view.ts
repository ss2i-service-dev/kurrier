// ss2i : Boite d'envoi (OI 10519), partie pure de l'interface (cf. apps/web/test/outbox-view.ts) :
// libelles des etats, place de l'entree dans la barre laterale, actualisation, et brouillons que
// Drafts laisse a la Boite d'envoi. Etats et actions : packages/common/src/outbox-state.ts.
import type { SendState } from "@common/outbox-state";
import type { DraftSendState } from "@common/draft-send";

type K = (en: string, fr: string) => string;

export function outboxStateLabel(state: SendState, k: K): string {
	switch (state) {
		case "pending":
			return k("Waiting to be sent", "En attente d'envoi");
		case "sending":
			return k("Sending", "Envoi en cours");
		case "failed":
			return k("Not sent", "Non envoyé");
		case "interrupted":
			return k("Interrupted: may have been sent", "Interrompu : peut-être parti");
		case "canceled":
			return k("Canceled", "Annulé");
		case "delivered":
			return k("Sent", "Parti");
		case "queued":
			return k("Queued by the mail server", "En file sur le serveur d'envoi");
		case "canceling":
			return k("Canceling", "Annulation en cours");
		case "rejected":
			return k("Rejected by the recipient's server", "Refusé par le serveur du destinataire");
		case "unknown":
			return k("Status unknown", "État inconnu");
	}
}

// Etats calmes (rien a faire) ; les autres etats visibles sont des alertes (outboxCountOf).
export const isOutboxCalm = (state: SendState) => state === "pending" || state === "sending" || state === "queued";

// Entree virtuelle entre Drafts et Sent : juste apres Drafts, sinon avant Sent, sinon en fin.
export function outboxSlot(kinds: string[]): number {
	const drafts = kinds.indexOf("drafts");
	if (drafts >= 0) return drafts + 1;
	const sent = kinds.indexOf("sent");
	return sent >= 0 ? sent : kinds.length;
}

// Suivi d'une identite pour l'actualisation : envois qui bougent (sending, file distante) et
// heures des envois en attente.
export type OutboxTracking = { busy: number; pendingAt: string[] };

export const OUTBOX_POLL_MS = 10_000;
const COUNTDOWN_MS = 2 * 60_000; // en dessous, decompte (lib/send-phase.ts, SCHEDULED_AFTER_MS)
const OVERDUE_MS = 3 * 60_000; // au-dela, etat inconnu (SEND_UNKNOWN_AFTER_MS) : plus de sondage

// Sondage toutes les 10 s tant qu'un envoi part ou qu'un decompte court ; un envoi programme ne
// fait sonder personne : un seul reveil 2 minutes avant son heure.
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

// Un brouillon ne quitte Drafts que si sa marque d'envoi designe une ligne visible de la Boite
// d'envoi. Marque perimee (ligne annulee ou partie, restauration en echec) ou ancienne marque
// undo-send-* : il reste dans Drafts avec son badge, jamais absent des deux listes.
export function inOutbox(draftSend: DraftSendState | null | undefined, outboxIds: ReadonlySet<string>): boolean {
	const jobId = draftSend?.pendingSend?.jobId;
	return !!jobId && outboxIds.has(String(jobId));
}
