// ss2i : rappels de reunion a plusieurs paliers (Samuel, 19/11). Un evenement Graph ne porte
// qu'un rappel natif ; ceux crees par « Ajouter a l'agenda » en ont jusqu'a trois (1 h avant,
// 15 min avant, a l'heure) et la liste complete vit dans la propriete etendue ss2iReminders.
// Les paliers que Graph ne declenche pas sont calcules ici, puis fusionnes avec reminderView
// pour le bandeau d'alerte. Fonctions pures (heures murales "YYYY-MM-DDTHH:mm" du fuseau
// d'affichage), appels Graph dans outlook-graph.ts.
import type { DueReminder } from "./outlook-graph";

/** Le bandeau s'en va 10 minutes apres le debut. */
export const ALERT_AFTER_MIN = 10;

/** Minutes (decimales) de `a` a `b`, deux "YYYY-MM-DDTHH:mm" du meme fuseau. */
export const minutesTo = (a: string, b: string) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60_000;

/** Rappel a afficher maintenant : heure du rappel passee, reunion pas finie ni commencee depuis plus de 10 min. */
export function alertDue(r: DueReminder, now: string): boolean {
	return r.fireAt <= now && r.end > now && minutesTo(now, r.start) >= -ALERT_AFTER_MIN;
}

export function countdownLabel(start: string, now: string): string {
	const m = Math.round(minutesTo(now, start));
	if (m >= 60 * 24) return `Le ${start.slice(8, 10)}/${start.slice(5, 7)} à ${start.slice(11, 16)}`;
	if (m >= 60) return `Commence dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
	if (m > 0) return `Commence dans ${m} min`;
	if (m === 0) return "Commence maintenant";
	return `A commencé il y a ${-m} min`;
}

/** Cle d'un palier : un palier fermé ne revient pas, les autres du meme evenement restent. */
export const reminderKey = (r: DueReminder) => `meet:${r.eventId}:${r.fireAt}`;

/** Evenement a rappels multiples, tel que lu sur Graph. */
export type ReminderSource = {
	eventId: string;
	title: string;
	start: string;
	end: string;
	allDay?: boolean;
	location?: string;
	webLink?: string;
	joinUrl?: string;
	/** Rappel natif (reminderMinutesBeforeStart), null s'il est coupe. */
	nativeMinutes: number | null;
	/** Liste de la propriete ss2iReminders. */
	offsets: number[];
};

/** « 60,15,0 » -> [60, 15, 0] : entiers de 0 a 7 jours, sans doublon, du plus lointain au plus proche ; le reste est ignore. */
export function parseReminderOffsets(value: unknown): number[] {
	if (typeof value !== "string") return [];
	const list = value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^\d+$/.test(s))
		.map(Number)
		.filter((m) => m <= 7 * 24 * 60);
	return [...new Set(list)].sort((a, b) => b - a);
}

const minus = (start: string, minutes: number) => new Date(Date.parse(`${start}:00Z`) - minutes * 60_000).toISOString().slice(0, 16);

/** Paliers que Graph ne declenche pas : tous ceux de la liste sauf le rappel natif, a debut - ecart. */
export function extraReminders(sources: ReminderSource[]): DueReminder[] {
	return sources
		.filter((s) => !s.allDay)
		.flatMap((s) =>
			s.offsets
				.filter((o) => o !== s.nativeMinutes)
				.map((o) => ({ eventId: s.eventId, title: s.title, start: s.start, end: s.end, location: s.location, webLink: s.webLink, joinUrl: s.joinUrl, fireAt: minus(s.start, o), extra: true as const })),
		);
}

/** Rappels d'Outlook et paliers supplementaires, un seul par (evenement, heure) : celui d'Outlook l'emporte. Tries par heure. */
export function mergeReminders(native: DueReminder[], extra: DueReminder[]): DueReminder[] {
	const seen = new Set(native.map((r) => `${r.eventId}|${r.fireAt}`));
	const added = extra.filter((r) => !seen.has(`${r.eventId}|${r.fireAt}`) && seen.add(`${r.eventId}|${r.fireAt}`));
	return [...native, ...added].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}

/**
 * Bandeaux a montrer : un seul par evenement, son palier du moment (le plus recent a avoir
 * sonne remplace le precedent, qui ne revient pas), sauf si ce palier est ferme. Fermer un
 * palier ne touche pas ceux a venir. Tries par debut.
 */
export function bannerList(list: DueReminder[], now: string, closed: ReadonlySet<string>): DueReminder[] {
	const latest = new Map<string, DueReminder>();
	for (const r of list) {
		if (!alertDue(r, now)) continue;
		const cur = latest.get(r.eventId);
		if (!cur || r.fireAt > cur.fireAt) latest.set(r.eventId, r);
	}
	return [...latest.values()].filter((r) => !closed.has(reminderKey(r))).sort((a, b) => a.start.localeCompare(b.start));
}

/** Paliers supplementaires repousses (« Dans 5 min ») : cle d'origine -> nouvelle heure ; Outlook ne connait pas ces paliers, courrier garde le report. */
export function applySnoozes(list: DueReminder[], snoozes: Record<string, string>): DueReminder[] {
	return list.map((r) => (r.extra && snoozes[reminderKey(r)] ? { ...r, fireAt: snoozes[reminderKey(r)] } : r));
}
