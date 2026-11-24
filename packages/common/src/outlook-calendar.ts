// ss2i : agenda Outlook dans courrier, facon Notion Calendar (Hugo le 05/11 : « qu'on retrouve
// notre calendrier Outlook comme on avait avant [...] pouvoir voir un calendrier sur deux
// semaines quand on planifie, par exemple on est vendredi et il faut pouvoir planifier sur la
// semaine d'apres »). Lecture des evenements par Microsoft Graph en app-only (meme application
// que « Ajouter a l'agenda », permission Calendars.ReadWrite), dates en heure de Paris.
// Code pur (dates, mise en page des colonnes) et appels HTTP, sans base : partage par le web
// et les tests.
import { AGENDA_TIMEZONE, AgendaError, type AgendaEvent, type GraphConfig, addDays, defaultReminders, graphToken } from "./thread-agenda";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Plus longue periode lue d'un coup (jours). */
export const CALENDAR_MAX_DAYS = 62;

/** Nombres de jours proposes a l'ecran, 14 = deux semaines a partir du lundi. */
export const CALENDAR_DAY_COUNTS = [1, 3, 7, 14] as const;
export type CalendarDayCount = (typeof CALENDAR_DAY_COUNTS)[number];

/**
 * Evenement Outlook a l'ecran. Horaire : start/end en "YYYY-MM-DDTHH:mm" (Paris). Journee
 * entiere : start/end en "YYYY-MM-DD", fin incluse (Graph rend le lendemain a 00:00).
 */
export type CalendarEvent = {
	id: string;
	title: string;
	allDay: boolean;
	start: string;
	end: string;
	location?: string;
	/** free | tentative | busy | oof | workingElsewhere | unknown */
	showAs?: string;
	webLink?: string;
	organizer?: string;
	/** Evenement d'une proposition pas encore creee (fenetre « Ajouter a l'agenda »). */
	ghost?: boolean;
	/** Proposition en cours d'edition : un clic sur un creneau la deplace. */
	active?: boolean;
	/** Agenda d'origine (cle de source : agenda de la boite ou collegue) et sa couleur. */
	calendarId?: string;
	sourceKey?: string;
	color?: string;
	/** Je l'organise (sinon : invitation recue, ou agenda d'un collegue). */
	isOrganizer?: boolean;
	/** Ma reponse a l'invitation. */
	responseStatus?: "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded";
	joinUrl?: string;
	recurring?: boolean;
	isPrivate?: boolean;
	/** Deplacable et modifiable depuis courrier (droit d'ecriture sur l'agenda). */
	editable?: boolean;
	/** Categories Outlook (noms) ; la couleur de la premiere colore l'evenement, comme Outlook. */
	categories?: string[];
	/** Rappel (minutes avant le debut), null : aucun. */
	reminderMinutes?: number | null;
	hasAttachments?: boolean;
	/** Autres horaires proposes par des participants (reunion que j'organise). */
	/** Autres personnes de la reunion (organisateur et invites, sans moi ni les salles) ; absent : entree perso. */
	guests?: { address: string; name?: string }[];
	proposals?: { address: string; name?: string; start: string; end: string }[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Date du jour a Paris (YYYY-MM-DD), quel que soit le fuseau du serveur ou du poste. */
export function todayInParis(now: Date = new Date(), tz: string = AGENDA_TIMEZONE): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Heure courante a Paris (ou dans le fuseau donne), en minutes depuis minuit. */
export function minutesNowInParis(now: Date = new Date(), tz: string = AGENDA_TIMEZONE): number {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
	return get("hour") * 60 + get("minute");
}

/** Jour de la semaine d'une date YYYY-MM-DD (0 = dimanche). */
export const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Lundi de la semaine de la date. */
export function mondayOf(date: string): string {
	const d = weekday(date);
	return addDays(date, d === 0 ? -6 : 1 - d);
}

/**
 * Premier jour affiche : lundi de la semaine pour 7 et 14 jours (un vendredi, les 14 jours
 * montrent la semaine en cours et la suivante), le jour lui-meme pour 1 et 3 jours.
 */
export function rangeStart(date: string, days: number): string {
	return days >= 7 ? mondayOf(date) : date;
}

/** Les `n` dates a partir de `start`. */
export function dayList(start: string, n: number): string[] {
	return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(start, i));
}

/** Pas des fleches : une semaine pour 7 et 14 jours (comme Notion Calendar), sinon le nombre de jours. */
export const navigationStep = (days: number) => (days >= 7 ? 7 : days);

const MOIS_COURT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const JOURS_COURTS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

const ymd = (date: string) => date.split("-").map(Number) as [number, number, number];

/** « 2 – 15 novembre 2026 », « 30 novembre – 13 décembre 2026 », « 28 déc. 2026 – 10 janv. 2027 ». */
export function rangeLabel(start: string, days: number): string {
	const end = addDays(start, Math.max(0, days - 1));
	const [y1, m1, d1] = ymd(start);
	const [y2, m2, d2] = ymd(end);
	const one = (d: number) => (d === 1 ? "1er" : String(d));
	if (start === end) return `${JOURS_COURTS[weekday(start)].replace(".", "")} ${one(d1)} ${MOIS[m1 - 1]} ${y1}`;
	if (y1 !== y2) return `${one(d1)} ${MOIS_COURT[m1 - 1]} ${y1} – ${one(d2)} ${MOIS_COURT[m2 - 1]} ${y2}`;
	if (m1 !== m2) return `${one(d1)} ${MOIS[m1 - 1]} – ${one(d2)} ${MOIS[m2 - 1]} ${y2}`;
	return `${one(d1)} – ${one(d2)} ${MOIS[m2 - 1]} ${y2}`;
}

/** "YYYY-MM-DDTHH:mm" -> minutes depuis minuit. */
export const minutesOf = (v: string) => Number(v.slice(11, 13)) * 60 + Number(v.slice(14, 16));

/** Minutes -> "HH:mm" (24:00 rendu 23:59 : un champ heure ne prend pas 24:00). */
export function hhmm(minutes: number): string {
	const m = Math.max(0, Math.min(minutes, 23 * 60 + 59));
	return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// ---------------------------------------------------------------------------
// Lecture Graph
// ---------------------------------------------------------------------------

/** "2026-11-05T09:30:00.0000000" -> "2026-11-05T09:30". */
const graphLocal = (v: unknown) => String(v ?? "").slice(0, 16);

/** Evenement Graph (calendarView, en-tete Prefer outlook.timezone = Paris) -> evenement a l'ecran. */
export function fromGraphEvent(raw: any): CalendarEvent | null {
	if (!raw || typeof raw !== "object" || raw.isCancelled) return null;
	const start = graphLocal(raw.start?.dateTime);
	const end = graphLocal(raw.end?.dateTime);
	if (start.length < 16 || end.length < 16) return null;
	const allDay = !!raw.isAllDay;
	const ev: CalendarEvent = {
		id: String(raw.id ?? `${start}-${raw.subject ?? ""}`),
		title: String(raw.subject ?? "").trim() || "(Sans titre)",
		allDay,
		// Journee entiere : fin exclusive a 00:00 chez Graph, incluse ici.
		start: allDay ? start.slice(0, 10) : start,
		end: allDay ? (end.slice(0, 10) > start.slice(0, 10) ? addDays(end.slice(0, 10), -1) : start.slice(0, 10)) : end < start ? start : end,
	};
	const loc = String(raw.location?.displayName ?? "").trim();
	if (loc) ev.location = loc;
	if (raw.showAs) ev.showAs = String(raw.showAs);
	if (raw.webLink) ev.webLink = String(raw.webLink);
	const org = String(raw.organizer?.emailAddress?.name ?? raw.organizer?.emailAddress?.address ?? "").trim();
	if (org) ev.organizer = org;
	return ev;
}

/** Bornes valides : dates YYYY-MM-DD, debut avant fin, au plus CALENDAR_MAX_DAYS jours. */
export function checkRange(from: string, to: string): void {
	if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) throw new AgendaError("Période invalide.");
	if (to < from) throw new AgendaError("Période invalide : la fin précède le début.");
	if (to > addDays(from, CALENDAR_MAX_DAYS)) throw new AgendaError(`Période trop longue (${CALENDAR_MAX_DAYS} jours au plus).`);
}

/**
 * Evenements de l'agenda par defaut de la boite entre `from` (inclus) et `to` (exclu), dates
 * de Paris. calendarView deplie les series recurrentes ; les pages suivantes (@odata.nextLink)
 * sont lues jusqu'a 1 000 evenements.
 */
export async function listGraphEvents(cfg: GraphConfig, mailbox: string, from: string, to: string): Promise<CalendarEvent[]> {
	checkRange(from, to);
	const token = await graphToken(cfg);
	const params = new URLSearchParams({
		startDateTime: `${from}T00:00:00`,
		endDateTime: `${to}T00:00:00`,
		$select: "id,subject,start,end,isAllDay,location,showAs,webLink,isCancelled,organizer",
		$orderby: "start/dateTime",
		$top: "250",
	});
	let url: string | null = `${GRAPH}/users/${encodeURIComponent(mailbox)}/calendarView?${params.toString()}`;
	const out: CalendarEvent[] = [];
	for (let page = 0; url && page < 4; page++) {
		const res: Response = await (cfg.fetchImpl ?? fetch)(url, {
			headers: {
				authorization: `Bearer ${token}`,
				// Dates rendues en heure de Paris (sinon UTC) ; startDateTime sans fuseau est lu dans ce fuseau.
				prefer: `outlook.timezone="${AGENDA_TIMEZONE}"`,
			},
		});
		const data: any = await res.json().catch(() => null);
		if (!res.ok) {
			const code = String(data?.error?.code ?? "");
			if (res.status === 404 || code === "ErrorInvalidUser" || code === "MailboxNotEnabledForRESTAPI") {
				throw new AgendaError(`${mailbox} n'est pas une boîte du tenant Microsoft 365 : son agenda Outlook n'est pas accessible.`);
			}
			if (res.status === 401 || res.status === 403) {
				throw new AgendaError(`Microsoft Graph refuse la lecture de l'agenda de ${mailbox} (HTTP ${res.status}) : permission applicative Calendars.Read ou Calendars.ReadWrite à vérifier.`);
			}
			throw new AgendaError(`Lecture de l'agenda refusée par Microsoft Graph (HTTP ${res.status}${data?.error?.message ? ` : ${data.error.message}` : ""}).`);
		}
		for (const raw of Array.isArray(data?.value) ? data.value : []) {
			const ev = fromGraphEvent(raw);
			if (ev) out.push(ev);
		}
		url = typeof data?.["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Mise en page
// ---------------------------------------------------------------------------

/** Un evenement journee entiere touche-t-il ce jour ? */
export const allDayCovers = (e: CalendarEvent, date: string) => e.allDay && e.start <= date && e.end >= date;

export type PlacedEvent = {
	event: CalendarEvent;
	/** Minutes depuis minuit, bornees au jour. */
	top: number;
	bottom: number;
	/** Colonne et nombre de colonnes du groupe d'evenements qui se chevauchent. */
	col: number;
	cols: number;
};

/**
 * Evenements horaires d'un jour, places en colonnes comme Outlook / Notion Calendar : les
 * evenements qui se chevauchent se partagent la largeur, un evenement de plusieurs jours est
 * coupe a minuit, un evenement trop court garde une hauteur lisible (15 min).
 */
export function layoutDay(events: CalendarEvent[], date: string): PlacedEvent[] {
	const dayStart = `${date}T00:00`;
	const dayEnd = `${addDays(date, 1)}T00:00`;
	const items = events
		.filter((e) => !e.allDay && e.start < dayEnd && (e.end > dayStart || (e.end === e.start && e.start >= dayStart)))
		.map((e) => {
			const top = e.start <= dayStart ? 0 : minutesOf(e.start);
			const bottom = e.end >= dayEnd ? 24 * 60 : minutesOf(e.end);
			return { event: e, top, bottom: Math.max(bottom, top + 15), col: 0, cols: 1 };
		})
		.sort((a, b) => a.top - b.top || b.bottom - a.bottom || Number(!!a.event.ghost) - Number(!!b.event.ghost));

	// Groupes de chevauchement, puis premiere colonne libre dans chaque groupe.
	let group: PlacedEvent[] = [];
	let groupEnd = -1;
	const ends: number[] = [];
	const flush = () => {
		const n = Math.max(1, ...group.map((p) => p.col + 1));
		for (const p of group) p.cols = n;
		group = [];
		ends.length = 0;
	};
	for (const p of items) {
		if (group.length && p.top >= groupEnd) flush();
		let col = ends.findIndex((end) => end <= p.top);
		if (col === -1) col = ends.length;
		ends[col] = p.bottom;
		p.col = col;
		group.push(p);
		groupEnd = Math.max(groupEnd, p.bottom);
	}
	if (group.length) flush();
	return items;
}

/** Heure de la grille sous le pointeur, arrondie au quart d'heure inferieur. */
export function slotFromOffset(offsetPx: number, hourHeight: number): number {
	const m = Math.floor(((offsetPx / hourHeight) * 60) / 15) * 15;
	return Math.max(0, Math.min(m, 24 * 60 - 15));
}

/** Jours entre deux dates YYYY-MM-DD. */
const daySpan = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Proposition deplacee sur un creneau de l'agenda (minutes = null : journee entiere). */
export function placeEvent(r: Pick<AgendaEvent, "allDay" | "start" | "end" | "reminders">, date: string, minutes: number | null): Pick<AgendaEvent, "allDay" | "start" | "end" | "reminders"> {
	const valid = (v: string, len: number) => v.length >= len && !Number.isNaN(Date.parse(`${v.slice(0, 10)}T00:00:00Z`));
	if (minutes === null) {
		// Journee entiere : meme nombre de jours qu'avant.
		const span = r.allDay && valid(r.start, 10) && valid(r.end, 10) ? Math.max(0, daySpan(r.start.slice(0, 10), r.end.slice(0, 10))) : 0;
		return { allDay: true, start: date, end: addDays(date, span), reminders: r.allDay ? r.reminders : defaultReminders(true) };
	}
	// Horaire : meme duree le meme jour (1 h par defaut), jamais au-dela de 23:59.
	let duration = 60;
	if (!r.allDay && valid(r.start, 16) && valid(r.end, 16) && r.start.slice(0, 10) === r.end.slice(0, 10)) {
		duration = Math.max(15, minutesOf(r.end) - minutesOf(r.start));
	}
	return {
		allDay: false,
		start: `${date}T${hhmm(minutes)}`,
		end: `${date}T${hhmm(Math.min(minutes + duration, 23 * 60 + 59))}`,
		reminders: r.allDay ? defaultReminders(false) : r.reminders,
	};
}

// ---------------------------------------------------------------------------
// Vue mois et vues de la page Agenda
// ---------------------------------------------------------------------------

/** Vues de la page Agenda : 1, 3, 7 ou 14 jours en grille horaire, ou le mois. */
export type CalendarView = CalendarDayCount | "month";
export const CALENDAR_VIEWS: readonly CalendarView[] = [1, 3, 7, 14, "month"];
export const isCalendarView = (v: unknown): v is CalendarView => CALENDAR_VIEWS.includes(v as CalendarView);

/** Premier jour du mois de la date. */
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** Premier jour du mois decale de n mois. */
export function addMonths(date: string, n: number): string {
	const [y, m] = ymd(date);
	const t = new Date(Date.UTC(y, m - 1 + n, 1));
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`;
}

/** « novembre 2026 ». */
export function monthLabel(date: string): string {
	const [y, m] = ymd(date);
	return `${MOIS[m - 1]} ${y}`;
}

/** Jours de la grille du mois : du lundi de la semaine du 1er au dimanche de la semaine du dernier jour (5 ou 6 semaines). */
export function monthGrid(date: string): string[] {
	const first = monthStart(date);
	const last = addDays(addMonths(first, 1), -1);
	const start = mondayOf(first);
	const end = addDays(mondayOf(last), 6);
	const n = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
	return dayList(start, n);
}

/** Jours affiches par une vue autour de la date (mois : la grille entiere). */
export function viewDays(view: CalendarView, anchor: string): string[] {
	if (view === "month") return monthGrid(anchor);
	return dayList(rangeStart(anchor, view), view);
}

/** Date d'ancrage apres precedent / suivant. */
export function stepView(view: CalendarView, anchor: string, dir: 1 | -1): string {
	if (view === "month") return addMonths(anchor, dir);
	return addDays(rangeStart(anchor, view), dir * navigationStep(view));
}

/** Titre de la periode d'une vue. */
export const viewLabel = (view: CalendarView, anchor: string) =>
	view === "month" ? monthLabel(anchor) : rangeLabel(rangeStart(anchor, view), view);

/** Evenements d'un jour pour la vue mois : journees entieres puis horaires par heure de debut. */
export function eventsOfDay(events: CalendarEvent[], date: string): CalendarEvent[] {
	return events
		.filter((e) => (e.allDay ? allDayCovers(e, date) : e.start.slice(0, 10) <= date && e.end.slice(0, 10) >= date && !(e.end.slice(0, 10) === date && e.end.slice(11) === "00:00" && e.start.slice(0, 10) < date)))
		.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}

// ---------------------------------------------------------------------------
// Deplacement vers un autre jour (vue mois)
// ---------------------------------------------------------------------------

/** Meme evenement pose sur un autre jour : memes heures et meme duree (en jours pour une journee entiere). */
export function shiftToDay(e: Pick<CalendarEvent, "allDay" | "start" | "end">, date: string): { allDay: boolean; start: string; end: string } {
	const from = e.start.slice(0, 10);
	const delta = daySpan(from, date);
	if (e.allDay) return { allDay: true, start: date, end: addDays(e.end.slice(0, 10), delta) };
	return { allDay: false, start: `${date}${e.start.slice(10)}`, end: `${addDays(e.end.slice(0, 10), delta)}${e.end.slice(10)}` };
}

// ---------------------------------------------------------------------------
// Fuseaux horaires
// ---------------------------------------------------------------------------

/** Fuseaux proposes (noms IANA, acceptes par Graph dans Prefer et dateTimeTimeZone). */
export const TIME_ZONES: { value: string; label: string }[] = [
	{ value: "Europe/Paris", label: "Paris (UTC+1/+2)" },
	{ value: "Europe/London", label: "Londres (UTC+0/+1)" },
	{ value: "Europe/Lisbon", label: "Lisbonne (UTC+0/+1)" },
	{ value: "Europe/Athens", label: "Athènes (UTC+2/+3)" },
	{ value: "Africa/Casablanca", label: "Casablanca" },
	{ value: "Africa/Abidjan", label: "Abidjan, Dakar (UTC+0)" },
	{ value: "America/Toronto", label: "Montréal, Toronto (UTC-5/-4)" },
	{ value: "America/New_York", label: "New York (UTC-5/-4)" },
	{ value: "America/Vancouver", label: "Vancouver (UTC-8/-7)" },
	{ value: "America/Martinique", label: "Antilles (UTC-4)" },
	{ value: "America/Cayenne", label: "Guyane (UTC-3)" },
	{ value: "Indian/Reunion", label: "La Réunion (UTC+4)" },
	{ value: "Asia/Dubai", label: "Dubaï (UTC+4)" },
	{ value: "Asia/Tokyo", label: "Tokyo (UTC+9)" },
	{ value: "Pacific/Noumea", label: "Nouméa (UTC+11)" },
	{ value: "Pacific/Tahiti", label: "Tahiti (UTC-10)" },
	{ value: "UTC", label: "UTC" },
];

/** Fuseau IANA reconnu par le moteur (sinon Paris). */
export function safeTimeZone(v: unknown): string {
	const tz = typeof v === "string" ? v.trim() : "";
	if (!tz || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return AGENDA_TIMEZONE;
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return tz;
	} catch {
		return AGENDA_TIMEZONE;
	}
}

/** Decalage (minutes) du fuseau par rapport a UTC a l'instant donne. */
function offsetMinutes(utcMs: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(utcMs));
	const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
	const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
	return Math.round((asUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/** "YYYY-MM-DDTHH:mm" lu dans le fuseau `tz` -> instant UTC (ms). */
export function zonedToUtc(local: string, tz: string): number {
	const guess = Date.parse(`${local.slice(0, 16)}:00Z`);
	let t = guess - offsetMinutes(guess, tz) * 60_000;
	t = guess - offsetMinutes(t, tz) * 60_000;
	return t;
}

/** Instant UTC (ms) -> "YYYY-MM-DDTHH:mm" dans le fuseau `tz`. */
export function utcToZoned(utcMs: number, tz: string): string {
	const d = new Date(utcMs + offsetMinutes(utcMs, tz) * 60_000);
	return d.toISOString().slice(0, 16);
}

/** Heure locale d'un fuseau convertie dans un autre ("YYYY-MM-DDTHH:mm"). */
export const convertZone = (local: string, fromTz: string, toTz: string) => (fromTz === toTz ? local.slice(0, 16) : utcToZoned(zonedToUtc(local, fromTz), toTz));

// ---------------------------------------------------------------------------
// Assistant de planification
// ---------------------------------------------------------------------------

export type BusyBlock = { start: string; end: string; status?: string };

/**
 * Creneaux libres pour tout le monde, dans les heures de travail (lundi-vendredi, 8 h 30 -
 * 18 h par defaut), par pas de 30 minutes, apres `notBefore` ("YYYY-MM-DDTHH:mm"). Un
 * bloc « libre » ou « travail ailleurs » n'occupe pas. Rend au plus `max` creneaux.
 */
export function freeSlots(
	busy: BusyBlock[][],
	days: string[],
	duration: number,
	opts: { workStart?: number; workEnd?: number; step?: number; notBefore?: string; max?: number; weekends?: boolean } = {},
): { start: string; end: string }[] {
	const workStart = opts.workStart ?? 8 * 60 + 30;
	const workEnd = opts.workEnd ?? 18 * 60;
	const step = opts.step ?? 30;
	const max = opts.max ?? 6;
	const blocks = busy.flat().filter((b) => b.status !== "free" && b.status !== "workingElsewhere");
	const out: { start: string; end: string }[] = [];
	for (const d of days) {
		const wd = weekday(d);
		if (!opts.weekends && (wd === 0 || wd === 6)) continue;
		for (let m = Math.ceil(workStart / step) * step; m + duration <= workEnd; m += step) {
			const start = `${d}T${hhmm(m)}`;
			const end = `${d}T${hhmm(m + duration)}`;
			if (opts.notBefore && start < opts.notBefore) continue;
			if (blocks.some((b) => b.start < end && b.end > start)) continue;
			out.push({ start, end });
			if (out.length >= max) return out;
			// un seul creneau par heure pleine suffit a la suggestion
			m += Math.max(0, 60 - step);
		}
	}
	return out;
}
