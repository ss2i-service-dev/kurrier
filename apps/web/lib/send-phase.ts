// ss2i : phase d'un envoi suivi (marque pendingSend d'un brouillon), partie pure de
// components/mailbox/default/draft-send-status.tsx (testable sans React, cf.
// apps/web/test/schedule-send.ts).
import { formatScheduledWhen } from "../../../packages/common/src/schedule-send";

// Un envoi dont l'heure est depassee de plus de 3 minutes sans que le brouillon ait
// disparu est d'etat inconnu : on n'actualise plus indefiniment.
export const SEND_UNKNOWN_AFTER_MS = 3 * 60_000;
export const SEND_REFRESH_MS = 3_000;
// Au-dela de 2 minutes d'attente, l'envoi est « programme » (heure affichee, ni decompte
// d'une seconde ni actualisation toutes les 3 s) ; en dessous, c'est le decompte du delai
// d'annulation.
export const SCHEDULED_AFTER_MS = 2 * 60_000;

export type SendPhase = "scheduled" | "countdown" | "sending" | "unknown";

export function sendPhaseOf(sendAt: string, now: number): SendPhase {
	const at = new Date(sendAt).getTime();
	if (Number.isNaN(at) || now - at > SEND_UNKNOWN_AFTER_MS) return "unknown";
	if (at - now > SCHEDULED_AFTER_MS) return "scheduled";
	return at > now ? "countdown" : "sending";
}

// Suivi d'un ensemble d'envois : `fast` = au moins un decompte ou envoi en cours (horloge de
// 1 s, actualisation toutes les 3 s) ; `wakeAt` = instant du premier passage d'un envoi
// programme au decompte (une seule actualisation, pas de tic d'ici la), null sinon.
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
	k: (en: string, fr: string) => string = (en) => en,
	// Fuseau d'affichage : undefined = celui de l'environnement ; null = pas encore connu (rendu
	// serveur, avant le montage : l'heure n'est affichee qu'une fois le fuseau du navigateur lu).
	tz?: string | null,
) {
	const phase = sendPhaseOf(sendAt, now);
	if (phase === "unknown") return k("Sending status unknown", "État d'envoi inconnu");
	if (phase === "sending") return k("Sending…", "Envoi en cours…");
	if (phase === "scheduled") {
		if (tz === null) return k("Scheduled", "Programmé");
		const at = new Date(sendAt);
		const when = (lang: "fr" | "en") => formatScheduledWhen(at, lang, tz ?? undefined, new Date(now));
		return k(`Scheduled for ${when("en")}`, `Programmé pour ${when("fr")}`);
	}
	const s = Math.max(1, Math.ceil((new Date(sendAt).getTime() - now) / 1000));
	return k(`Sending in ${s}s`, `Envoi dans ${s} s`);
}
