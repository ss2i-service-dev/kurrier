// ss2i : encart « agenda du jour » au-dessus d'une invitation (Samuel le 19/11/2026 : « j'ai
// envie de voir directement au-dessus du mail [...] a quel endroit sur le calendrier ca va se
// positionner l'invitation en question. Histoire que je vois s'il y a des conflits, des trucs
// juste avant, juste apres »). Logique pure, sans React : l'invitation (horodatages de la base,
// UTC) devient un evenement fantome a l'heure de Paris, au format de la grille de l'agenda ;
// l'evenement deja present dans Outlook (invitation acceptee) n'est pas dedouble ; les conflits
// sont des chevauchements stricts avec ce que l'agenda marque occupe. Composant :
// components/outlook-calendar/invite-day-preview.tsx. Test : apps/web/test/invite-day-preview.ts.
import { AGENDA_TIMEZONE, addDays } from "../../../packages/common/src/thread-agenda";
import type { CalendarEvent } from "../../../packages/common/src/outlook-calendar";

export type InviteSource = {
	title?: string | null;
	isAllDay?: boolean | null;
	startsAt?: Date | string | null;
	endsAt?: Date | string | null;
};

/**
 * Invitation a l'heure de Paris. Horaire : start/end en "YYYY-MM-DDTHH:mm". Journee entiere :
 * start et end valent le premier jour (une invitation sur plusieurs jours montre le premier).
 */
export type InviteSlot = { title: string; allDay: boolean; day: string; start: string; end: string };

export type InviteConflict = { id: string; title: string; allDay: boolean; from: string; to: string };

const DEFAULT_LENGTH_MIN = 30;

function toDate(v: Date | string | null | undefined): Date | null {
	if (v === null || v === undefined || v === "") return null;
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? null : d;
}

/** « YYYY-MM-DDTHH:mm » de l'instant dans le fuseau (Paris par defaut). */
function wallTime(d: Date, tz: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(d);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Invitation placee sur le jour de son debut ; null sans date lisible. */
export function inviteSlot(ev: InviteSource, tz: string = AGENDA_TIMEZONE): InviteSlot | null {
	const startsAt = toDate(ev.startsAt);
	if (!startsAt) return null;
	const title = String(ev.title ?? "");
	const start = wallTime(startsAt, tz);
	const day = start.slice(0, 10);
	if (ev.isAllDay) return { title, allDay: true, day, start: day, end: day };
	const endsAt = toDate(ev.endsAt);
	const end = wallTime(endsAt && endsAt.getTime() > startsAt.getTime() ? endsAt : new Date(startsAt.getTime() + DEFAULT_LENGTH_MIN * 60_000), tz);
	return { title, allDay: false, day, start, end };
}

/** Minutes depuis minuit de l'heure d'un « YYYY-MM-DDTHH:mm ». */
const minutesOfStart = (start: string) => Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16));

/** Heure montree en haut de l'encart : une heure avant l'invitation ; journee entiere : 8 h. */
export function inviteScrollMinutes(slot: InviteSlot): number {
	return slot.allDay ? 8 * 60 : Math.max(0, minutesOfStart(slot.start) - 60);
}

const normTitle = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const sameInvite = (slot: InviteSlot, e: CalendarEvent) =>
	e.allDay === slot.allDay && e.start === slot.start && normTitle(e.title) === normTitle(slot.title);

/** Evenement deja dans l'agenda pour cette invitation (meme titre, meme debut), sinon null. */
export function findExistingEvent(slot: InviteSlot, events: CalendarEvent[]): CalendarEvent | null {
	return events.find((e) => sameInvite(slot, e)) ?? null;
}

/**
 * Evenements a dessiner : ceux de l'agenda, l'invitation en fantome actif (plein, non deplacable)
 * ou, si elle y est deja, l'evenement existant marque actif.
 */
export function invitePreviewEvents(slot: InviteSlot, events: CalendarEvent[]): CalendarEvent[] {
	const found = findExistingEvent(slot, events);
	if (found) return events.map((e) => (e.id === found.id ? { ...e, active: true } : e));
	return [
		...events,
		{ id: "invite-preview", title: slot.title.trim() || "(Sans titre)", allDay: slot.allDay, start: slot.start, end: slot.end, ghost: true, active: true },
	];
}

/**
 * Evenements en conflit : chevauchement strict (fin == debut n'est pas un conflit). Ne comptent
 * pas : l'invitation elle-meme, les evenements disponibles (free) et refuses. Invitation horaire :
 * les evenements horaires occupes, et les journees entieres d'absence (oof). Invitation en journee
 * entiere : les autres journees entieres occupees.
 */
export function inviteConflicts(slot: InviteSlot, events: CalendarEvent[]): InviteConflict[] {
	const dayStart = `${slot.day}T00:00`;
	const dayEnd = `${addDays(slot.day, 1)}T00:00`;
	const out: InviteConflict[] = [];
	for (const e of events) {
		if (sameInvite(slot, e) || e.showAs === "free" || e.responseStatus === "declined") continue;
		if (e.allDay) {
			if (slot.allDay ? !(e.start <= slot.day && slot.day <= e.end) : !(e.showAs === "oof" && e.start <= slot.day && slot.day <= e.end)) continue;
			out.push({ id: e.id, title: e.title, allDay: true, from: "00:00", to: "24:00" });
			continue;
		}
		if (slot.allDay || !(slot.start < e.end && e.start < slot.end)) continue;
		out.push({
			id: e.id,
			title: e.title,
			allDay: false,
			from: e.start < dayStart ? "00:00" : e.start.slice(11, 16),
			to: e.end >= dayEnd ? "24:00" : e.end.slice(11, 16),
		});
	}
	return out;
}

/** « Titre (10:00-11:00) », heures en 24 h ; journee entiere : « Titre (<libelle>) ». */
export function conflictLabel(c: InviteConflict, allDayLabel = "Journée entière"): string {
	return `${c.title} (${c.allDay ? allDayLabel : `${c.from}-${c.to}`})`;
}

/** Page agenda ouverte sur le jour (et la boite) de l'invitation. */
export const agendaUrl = (workspacePublicId: string, day: string, identityPublicId: string) =>
	`/w/${workspacePublicId}/dashboard/agenda?date=${day}&box=${encodeURIComponent(identityPublicId)}`;

/** Jour demandé par ?date=YYYY-MM-DD dans l'adresse de la page agenda, null s'il est absent ou invalide. */
export function agendaDateParam(search: string): string | null {
	const d = new URLSearchParams(search.replace(/^\?/, "")).get("date") ?? "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
	const t = new Date(`${d}T00:00:00Z`);
	return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
}
