// ss2i : agenda Outlook complet par Microsoft Graph (Hugo, 05/11 : « que ca fonctionne vraiment
// en remplacement d'Outlook mais que tout se fasse sur Outlook derriere [...] tout via
// Microsoft Graph »). Rien n'est stocke dans courrier : chaque lecture et chaque ecriture va a
// Graph (app-only, permission Calendars.ReadWrite), Outlook reste la source de verite et voit
// tout de suite ce qui est fait depuis courrier, et inversement.
// - agendas de la boite (/calendars) avec leur couleur ;
// - evenements d'une periode par agenda (calendarView : series deplies) ;
// - detail d'un evenement (participants et reponses, corps, lien Teams, recurrence) ;
// - creation, modification, deplacement, suppression ; annulation d'une reunion organisee
//   (les participants recoivent l'annulation) ; reponse a une invitation (accepter,
//   provisoire, refuser, avec un mot facultatif). Les invitations et mises a jour partent
//   des serveurs Microsoft comme depuis Outlook.
// Dates en heure de Paris, sans decalage, comme le reste de l'agenda.
import { AGENDA_TIMEZONE, AgendaError, type GraphConfig, addDays, graphToken } from "./thread-agenda";
import { type BusyBlock, type CalendarEvent, checkRange, convertZone, fromGraphEvent, safeTimeZone } from "./outlook-calendar";

const GRAPH = "https://graph.microsoft.com/v1.0";

export type OutlookCalendar = { id: string; name: string; color: string; isDefault: boolean; canEdit: boolean };

export type AttendeeType = "required" | "optional" | "resource";
export type AttendeeResponse = "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded";
export type Attendee = {
	address: string;
	name?: string;
	type: AttendeeType;
	response?: AttendeeResponse;
	/** Autre horaire propose par ce participant (dans le fuseau d'affichage). */
	proposed?: { start: string; end: string };
};

/** Piece jointe d'un evenement (sans son contenu). */
export type EventAttachment = { id: string; name: string; size: number; contentType: string; isInline: boolean };

/** Fichier joint a l'enregistrement (contenu en base64). */
export type NewAttachment = { name: string; contentType: string; base64: string };

/** Taille maximale d'une piece jointe (Outlook : 150 Mo par session d'envoi ; courrier : 25 Mo). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export type Room = { address: string; name: string; capacity?: number; building?: string; floor?: string };

/** Categorie Outlook (liste principale de la boite). */
export type OutlookCategory = { id: string; name: string; color: string; preset: string };

/** Recurrences simples proposees a la saisie ; « custom » = regle d'Outlook non modifiable ici. */
export type Recurrence = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly";
export const RECURRENCES: { value: Recurrence; label: string }[] = [
	{ value: "none", label: "Ne se répète pas" },
	{ value: "daily", label: "Tous les jours" },
	{ value: "weekdays", label: "Du lundi au vendredi" },
	{ value: "weekly", label: "Toutes les semaines" },
	{ value: "biweekly", label: "Toutes les deux semaines" },
	{ value: "monthly", label: "Tous les mois" },
	{ value: "yearly", label: "Tous les ans" },
];

export type ShowAs = "free" | "tentative" | "busy" | "oof" | "workingElsewhere";
export const SHOW_AS: { value: ShowAs; label: string }[] = [
	{ value: "busy", label: "Occupé" },
	{ value: "free", label: "Libre" },
	{ value: "tentative", label: "Provisoire" },
	{ value: "oof", label: "Absent" },
	{ value: "workingElsewhere", label: "Travail ailleurs" },
];

/** Rappels proposes (minutes avant le debut ; null = aucun). */
export const REMINDERS: { value: string; label: string }[] = [
	{ value: "none", label: "Aucun rappel" },
	{ value: "0", label: "Au début" },
	{ value: "5", label: "5 minutes avant" },
	{ value: "10", label: "10 minutes avant" },
	{ value: "15", label: "15 minutes avant" },
	{ value: "30", label: "30 minutes avant" },
	{ value: "60", label: "1 heure avant" },
	{ value: "120", label: "2 heures avant" },
	{ value: "960", label: "La veille à 8 h (journée entière)" },
	{ value: "1440", label: "1 jour avant" },
	{ value: "10080", label: "1 semaine avant" },
];

/** Evenement complet (fenetre de detail et formulaire de modification). */
export type EventDetail = CalendarEvent & {
	calendarId?: string;
	bodyHtml: string;
	attendees: Attendee[];
	organizerAddress?: string;
	isOrganizer: boolean;
	/** Ma reponse (invitation recue). */
	responseStatus: AttendeeResponse;
	/** singleInstance | occurrence | exception | seriesMaster */
	kind: string;
	seriesMasterId?: string;
	recurrence: Recurrence | "custom";
	recurrenceUntil?: string;
	recurrenceLabel?: string;
	isOnlineMeeting: boolean;
	joinUrl?: string;
	isPrivate: boolean;
	reminderMinutes: number | null;
	categories: string[];
	/** Salle reservee (participant de type ressource et lieu de la reunion). */
	room?: { address: string; name: string };
	allowNewTimeProposals: boolean;
	attachments: EventAttachment[];
	/** Fuseau dans lequel start / end sont exprimes. */
	timeZone: string;
};

/** Saisie du formulaire (creation et modification). */
export type EventInput = {
	title: string;
	allDay: boolean;
	/** YYYY-MM-DDTHH:mm, ou YYYY-MM-DD en journee entiere (fin incluse). */
	start: string;
	end: string;
	location?: string;
	/** Notes en texte ; envoyees seulement si notesChanged (le corps HTML d'Outlook est garde sinon). */
	notes?: string;
	notesChanged?: boolean;
	attendees: Attendee[];
	online: boolean;
	showAs: ShowAs;
	isPrivate: boolean;
	reminderMinutes: number | null;
	recurrence: Recurrence | "custom";
	/** Fin de la repetition (YYYY-MM-DD, incluse) ; absente = sans fin. */
	recurrenceUntil?: string;
	calendarId?: string;
	/** Fuseau des heures saisies (IANA) ; Paris par defaut. */
	timeZone?: string;
	categories?: string[];
	room?: { address: string; name: string };
	/** Les participants peuvent proposer un autre horaire (vrai par defaut, comme Outlook). */
	allowNewTimeProposals?: boolean;
};

export type EventScope = "occurrence" | "series";

// ---------------------------------------------------------------------------
// Validation et corps des requetes
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Texte -> HTML du corps (paragraphes, retours a la ligne, liens laisses tels quels). */
export const notesToHtml = (text: string) =>
	text
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("\n");

/** Saisie propre ou message d'erreur (verifiee cote serveur avant tout appel Graph). */
export function normalizeEventInput(raw: unknown): { input: EventInput } | { error: string } {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const title = clip(r.title, 255);
	if (!title) return { error: "Donnez un titre à l'événement." };
	const allDay = r.allDay === true;
	const start = clip(r.start, 16);
	const end = clip(r.end, 16);
	if (allDay) {
		if (!DATE_RE.test(start)) return { error: "Date de début invalide." };
		if (!DATE_RE.test(end)) return { error: "Date de fin invalide." };
		if (end < start) return { error: "La fin précède le début." };
	} else {
		if (!DATETIME_RE.test(start)) return { error: "Date ou heure de début invalide." };
		if (!DATETIME_RE.test(end)) return { error: "Date ou heure de fin invalide." };
		if (end <= start) return { error: "La fin doit suivre le début." };
	}
	const attendees: Attendee[] = [];
	const seen = new Set<string>();
	for (const a of Array.isArray(r.attendees) ? r.attendees.slice(0, 200) : []) {
		const address = clip((a as any)?.address, 320).toLowerCase();
		if (!address) continue;
		if (!EMAIL_RE.test(address)) return { error: `Adresse de participant invalide : ${address}` };
		if (seen.has(address)) continue;
		seen.add(address);
		const type = (["required", "optional", "resource"] as const).includes((a as any)?.type) ? (a as any).type : "required";
		attendees.push({ address, name: clip((a as any)?.name, 255) || undefined, type });
	}
	const showAs = SHOW_AS.some((s) => s.value === r.showAs) ? (r.showAs as ShowAs) : allDay ? "free" : "busy";
	const recurrence = r.recurrence === "custom" || RECURRENCES.some((x) => x.value === r.recurrence) ? (r.recurrence as Recurrence | "custom") : "none";
	const categories = [...new Set((Array.isArray(r.categories) ? r.categories : []).map((c) => clip(c, 255)).filter(Boolean))].slice(0, 25);
	let room: EventInput["room"];
	if (r.room && typeof r.room === "object") {
		const address = clip((r.room as any).address, 320).toLowerCase();
		if (!EMAIL_RE.test(address)) return { error: "Adresse de salle invalide." };
		room = { address, name: clip((r.room as any).name, 255) || address };
		if (!seen.has(address)) attendees.push({ address, name: room.name, type: "resource" });
	}
	const until = clip(r.recurrenceUntil, 10);
	if (until && !DATE_RE.test(until)) return { error: "Date de fin de répétition invalide." };
	if (until && until < start.slice(0, 10)) return { error: "La répétition finit avant le premier événement." };
	const rem = r.reminderMinutes;
	const reminderMinutes = rem === null || rem === undefined || rem === "" ? null : Number(rem);
	if (reminderMinutes !== null && (!Number.isFinite(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 40320)) {
		return { error: "Rappel invalide." };
	}
	return {
		input: {
			title,
			allDay,
			start,
			end,
			location: clip(r.location, 255) || undefined,
			notes: typeof r.notes === "string" ? r.notes.slice(0, 20000) : undefined,
			notesChanged: r.notesChanged === true,
			attendees,
			online: r.online === true,
			showAs,
			isPrivate: r.isPrivate === true,
			reminderMinutes,
			recurrence,
			recurrenceUntil: until || undefined,
			calendarId: clip(r.calendarId, 512) || undefined,
			timeZone: safeTimeZone(r.timeZone),
			categories,
			room,
			allowNewTimeProposals: r.allowNewTimeProposals !== false,
		},
	};
}

/** Regle de recurrence Graph d'une repetition simple, a partir du premier jour. */
export function graphRecurrence(rec: Recurrence, firstDay: string, until?: string, tz: string = AGENDA_TIMEZONE) {
	if (rec === "none") return null;
	const d = new Date(`${firstDay}T00:00:00Z`);
	const day = DAYS[d.getUTCDay()];
	const pattern: Record<string, unknown> =
		rec === "daily"
			? { type: "daily", interval: 1 }
			: rec === "weekdays"
				? { type: "weekly", interval: 1, daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], firstDayOfWeek: "monday" }
				: rec === "weekly" || rec === "biweekly"
					? { type: "weekly", interval: rec === "weekly" ? 1 : 2, daysOfWeek: [day], firstDayOfWeek: "monday" }
					: rec === "monthly"
						? { type: "absoluteMonthly", interval: 1, dayOfMonth: d.getUTCDate() }
						: { type: "absoluteYearly", interval: 1, dayOfMonth: d.getUTCDate(), month: d.getUTCMonth() + 1 };
	const range = until
		? { type: "endDate", startDate: firstDay, endDate: until, recurrenceTimeZone: tz }
		: { type: "noEnd", startDate: firstDay, recurrenceTimeZone: tz };
	return { pattern, range };
}

/** Regle Graph -> repetition simple (ou « custom » quand elle ne correspond a aucune). */
export function parseRecurrence(raw: any): { recurrence: Recurrence | "custom"; until?: string; label?: string } {
	const p = raw?.pattern;
	if (!p) return { recurrence: "none" };
	const until = raw?.range?.type === "endDate" && DATE_RE.test(String(raw.range.endDate)) ? String(raw.range.endDate) : undefined;
	const interval = Number(p.interval ?? 1);
	const days: string[] = Array.isArray(p.daysOfWeek) ? p.daysOfWeek.map((x: string) => String(x).toLowerCase()) : [];
	let recurrence: Recurrence | "custom" = "custom";
	if (p.type === "daily" && interval === 1) recurrence = "daily";
	else if (p.type === "weekly" && interval === 1 && days.length === 5 && ["monday", "tuesday", "wednesday", "thursday", "friday"].every((d) => days.includes(d))) recurrence = "weekdays";
	else if (p.type === "weekly" && days.length === 1 && (interval === 1 || interval === 2)) recurrence = interval === 1 ? "weekly" : "biweekly";
	else if (p.type === "absoluteMonthly" && interval === 1) recurrence = "monthly";
	else if (p.type === "absoluteYearly" && interval === 1) recurrence = "yearly";
	const label = recurrence === "custom" ? "Répétition personnalisée (Outlook)" : RECURRENCES.find((r) => r.value === recurrence)?.label;
	return { recurrence, until, label: until ? `${label}, jusqu'au ${until.split("-").reverse().join("/")}` : label };
}

const graphTimes = (allDay: boolean, start: string, end: string, tz: string = AGENDA_TIMEZONE) => ({
	isAllDay: allDay,
	start: { dateTime: allDay ? `${start}T00:00:00` : `${start}:00`, timeZone: tz },
	// Journee entiere : fin exclusive a 00:00 le lendemain du dernier jour (convention Graph).
	end: { dateTime: allDay ? `${addDays(end, 1)}T00:00:00` : `${end}:00`, timeZone: tz },
});

/**
 * Corps de POST / PATCH /events. En modification, le corps n'est envoye que si les notes ont
 * change (le HTML d'Outlook, mise en forme et invitation Teams comprises, est garde sinon), et
 * la recurrence seulement pour la serie entiere.
 */
export function graphEventPayload(i: EventInput, opts: { update?: boolean; recurrence?: boolean } = {}) {
	const tz = i.timeZone ?? AGENDA_TIMEZONE;
	const body: Record<string, unknown> = {
		subject: i.title,
		...graphTimes(i.allDay, i.start, i.end, tz),
		// Salle : lieu « salle de reunion » relie a sa boite (Outlook la montre comme salle reservee).
		location: i.room
			? { displayName: i.room.name, locationEmailAddress: i.room.address, locationType: "conferenceRoom" }
			: { displayName: i.location ?? "" },
		showAs: i.showAs,
		sensitivity: i.isPrivate ? "private" : "normal",
		isReminderOn: i.reminderMinutes !== null,
		attendees: i.attendees.map((a) => ({ emailAddress: { address: a.address, name: a.name ?? a.address }, type: a.type })),
		categories: i.categories ?? [],
		allowNewTimeProposals: i.allowNewTimeProposals !== false,
	};
	if (i.room && i.location && i.location.trim() && i.location.trim() !== i.room.name) {
		body.locations = [
			{ displayName: i.room.name, locationEmailAddress: i.room.address, locationType: "conferenceRoom" },
			{ displayName: i.location.trim() },
		];
	}
	if (i.reminderMinutes !== null) body.reminderMinutesBeforeStart = i.reminderMinutes;
	if (!opts.update || i.notesChanged) body.body = { contentType: "HTML", content: notesToHtml(i.notes ?? "") };
	// Teams : seulement a l'activation (Graph refuse de retirer une reunion Teams par PATCH).
	if (i.online) {
		body.isOnlineMeeting = true;
		body.onlineMeetingProvider = "teamsForBusiness";
	}
	if (opts.recurrence !== false && i.recurrence !== "custom") {
		const rec = graphRecurrence(i.recurrence, i.start.slice(0, 10), i.recurrenceUntil, tz);
		if (rec || opts.update) body.recurrence = rec;
	}
	return body;
}

/** Corps de PATCH pour un deplacement (glisser-deposer, redimensionnement). */
export const graphMovePayload = (allDay: boolean, start: string, end: string, tz: string = AGENDA_TIMEZONE) => graphTimes(allDay, start, end, tz);

// ---------------------------------------------------------------------------
// Appels Graph
// ---------------------------------------------------------------------------

/** Permission applicative a citer dans un refus, selon l'appel. */
export type GraphNeed = { permission?: string; mailbox?: string };

async function graph(cfg: GraphConfig, mailbox: string, method: string, path: string, body?: unknown, what = "Outlook", tz: string = AGENDA_TIMEZONE, need: GraphNeed = {}): Promise<any> {
	return graphUrl(cfg, `${GRAPH}/users/${encodeURIComponent(mailbox)}${path}`, method, body, what, tz, { mailbox, ...need });
}

async function graphUrl(cfg: GraphConfig, url: string, method: string, body?: unknown, what = "Outlook", tz: string = AGENDA_TIMEZONE, need: GraphNeed = {}): Promise<any> {
	const mailbox = need.mailbox ?? "la boîte";
	const token = await graphToken(cfg);
	const res = await (cfg.fetchImpl ?? fetch)(url, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			prefer: `outlook.timezone="${tz}", outlook.body-content-type="html"`,
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (res.status === 204 || res.status === 202) return null;
	const data: any = await res.json().catch(() => null);
	if (res.ok) return data;
	const code = String(data?.error?.code ?? "");
	if (code === "ErrorInvalidUser" || code === "MailboxNotEnabledForRESTAPI") {
		throw new AgendaError(`${mailbox} n'est pas une boîte du tenant Microsoft 365 : son agenda Outlook n'est pas accessible.`);
	}
	if (res.status === 404 || code === "ErrorItemNotFound") throw new AgendaError(`${what} introuvable dans Outlook (supprimé entre-temps ?).`);
	if (res.status === 401 || res.status === 403) {
		throw new AgendaError(
			need.permission
				? `Microsoft Graph refuse cet appel (HTTP ${res.status}) : ${need.permission}.`
				: `Microsoft Graph refuse l'accès à l'agenda de ${mailbox} (HTTP ${res.status}) : permission applicative Calendars.ReadWrite à vérifier.`,
		);
	}
	if (res.status === 429) throw new AgendaError("Microsoft Graph limite les appels : réessayez dans quelques secondes.");
	throw new AgendaError(`Refusé par Microsoft Graph (HTTP ${res.status}${data?.error?.message ? ` : ${data.error.message}` : ""}).`);
}

const ref = (id: string) => encodeURIComponent(String(id));

/** Couleur d'un agenda : hexColor d'Outlook, sinon le nom de couleur preset, sinon le bleu. */
const PRESET: Record<string, string> = {
	lightBlue: "#4f8de8",
	lightGreen: "#5fb35f",
	lightOrange: "#f0a14b",
	lightGray: "#9aa0a6",
	lightYellow: "#e5c33a",
	lightTeal: "#3fb5ad",
	lightPink: "#e57399",
	lightBrown: "#b0835a",
	lightRed: "#e05757",
	maxColor: "#7a6ad8",
};
export function calendarColor(raw: any, index: number): string {
	const hex = String(raw?.hexColor ?? "");
	if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
	const preset = PRESET[String(raw?.color ?? "")];
	if (preset) return preset;
	return ["#4f8de8", "#5fb35f", "#f0a14b", "#e57399", "#7a6ad8", "#3fb5ad"][index % 6];
}

/** Agendas de la boite, l'agenda par defaut en tete. */
export async function listCalendars(cfg: GraphConfig, mailbox: string): Promise<OutlookCalendar[]> {
	const data = await graph(cfg, mailbox, "GET", "/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=100", undefined, "Agenda");
	// Agendas de la boite elle-meme ; ceux des collegues passent par sharedCalendarOwners.
	const own = (Array.isArray(data?.value) ? data.value : []).filter(
		(c: any) => !c?.owner?.address || String(c.owner.address).toLowerCase() === mailbox.toLowerCase(),
	);
	const list: OutlookCalendar[] = own.map((c: any, i: number) => ({
		id: String(c.id),
		name: String(c.name ?? "Calendrier"),
		color: calendarColor(c, i),
		isDefault: !!c.isDefaultCalendar,
		canEdit: c.canEdit !== false,
	}));
	return list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

const LIST_SELECT =
	"id,subject,start,end,isAllDay,location,showAs,webLink,isCancelled,organizer,isOrganizer,responseStatus,isOnlineMeeting,onlineMeeting,type,seriesMasterId,sensitivity,categories,isReminderOn,reminderMinutesBeforeStart,hasAttachments,attendees";

/** Horaires proposes par les participants d'une reunion que j'organise. */
function proposalsOf(raw: any, tz: string): CalendarEvent["proposals"] {
	if (raw?.isOrganizer === false) return undefined;
	const list = (Array.isArray(raw?.attendees) ? raw.attendees : [])
		.filter((a: any) => a?.proposedNewTime?.start?.dateTime && a?.proposedNewTime?.end?.dateTime)
		.map((a: any) => ({
			address: String(a?.emailAddress?.address ?? "").toLowerCase(),
			name: a?.emailAddress?.name ? String(a.emailAddress.name) : undefined,
			start: graphZoned(a.proposedNewTime.start, tz),
			end: graphZoned(a.proposedNewTime.end, tz),
		}))
		.filter((p: any) => p.address && p.start && p.end);
	return list.length ? list : undefined;
}

/** Champs de liste en plus de fromGraphEvent (reponse, Teams, serie, propositions). */
function listExtras(raw: any, tz: string = AGENDA_TIMEZONE): Partial<CalendarEvent> {
	return {
		proposals: proposalsOf(raw, tz),
		isOrganizer: raw?.isOrganizer !== false,
		responseStatus: String(raw?.responseStatus?.response ?? "none") as CalendarEvent["responseStatus"],
		joinUrl: raw?.onlineMeeting?.joinUrl ? String(raw.onlineMeeting.joinUrl) : undefined,
		recurring: raw?.type === "occurrence" || raw?.type === "exception" || raw?.type === "seriesMaster",
		isPrivate: raw?.sensitivity === "private",
		categories: Array.isArray(raw?.categories) ? raw.categories.map(String) : [],
		reminderMinutes: raw?.isReminderOn ? Number(raw?.reminderMinutesBeforeStart ?? 15) : null,
		hasAttachments: !!raw?.hasAttachments,
	};
}

/** Date Graph (dateTimeTimeZone) dans le fuseau d'affichage : rendue telle quelle si deja dans ce fuseau, convertie depuis UTC sinon. */
export function graphZoned(v: any, tz: string): string {
	const dt = String(v?.dateTime ?? "").slice(0, 16);
	if (dt.length < 16) return "";
	const from = String(v?.timeZone ?? tz);
	if (from === tz) return dt;
	if (/^(utc|coordinated universal time|etc\/utc|gmt)$/i.test(from)) return convertZone(dt, "UTC", tz);
	try {
		return convertZone(dt, from, tz);
	} catch {
		return dt;
	}
}

/** Evenements d'un agenda (ou de l'agenda par defaut) du `from` inclus au `to` exclu. */
export async function listCalendarEvents(
	cfg: GraphConfig,
	mailbox: string,
	calendarId: string | undefined,
	from: string,
	to: string,
	tz: string = AGENDA_TIMEZONE,
): Promise<CalendarEvent[]> {
	checkRange(from, to);
	const params = new URLSearchParams({
		startDateTime: `${from}T00:00:00`,
		endDateTime: `${to}T00:00:00`,
		$select: LIST_SELECT,
		$orderby: "start/dateTime",
		$top: "250",
	});
	const base = calendarId ? `/calendars/${ref(calendarId)}/calendarView` : "/calendarView";
	let path: string | null = `${base}?${params.toString()}`;
	const out: CalendarEvent[] = [];
	for (let page = 0; path && page < 4; page++) {
		const data = await graph(cfg, mailbox, "GET", path, undefined, "Agenda", tz);
		for (const raw of Array.isArray(data?.value) ? data.value : []) {
			const ev = fromGraphEvent(raw);
			if (ev) out.push({ ...ev, ...listExtras(raw, tz), calendarId });
		}
		const next = typeof data?.["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
		// nextLink est une URL complete : on garde le chemin apres /users/{boite}
		path = next ? next.slice(next.indexOf("/users/") + `/users/`.length).replace(/^[^/]+/, "") : null;
	}
	return out;
}

/** Evenement Graph complet -> detail. */
export function toEventDetail(raw: any, calendarId?: string, tz: string = AGENDA_TIMEZONE): EventDetail | null {
	const base = fromGraphEvent(raw);
	if (!base) return null;
	const rec = parseRecurrence(raw?.recurrence);
	const organizerAddress = String(raw?.organizer?.emailAddress?.address ?? "").toLowerCase() || undefined;
	const attendees: Attendee[] = (Array.isArray(raw?.attendees) ? raw.attendees : [])
		.map((a: any) => ({
			address: String(a?.emailAddress?.address ?? "").toLowerCase(),
			name: a?.emailAddress?.name ? String(a.emailAddress.name) : undefined,
			type: (["required", "optional", "resource"].includes(a?.type) ? a.type : "required") as AttendeeType,
			response: String(a?.status?.response ?? "none") as AttendeeResponse,
			proposed:
				a?.proposedNewTime?.start?.dateTime && a?.proposedNewTime?.end?.dateTime
					? { start: graphZoned(a.proposedNewTime.start, tz), end: graphZoned(a.proposedNewTime.end, tz) }
					: undefined,
		}))
		.filter((a: Attendee) => a.address);
	const roomAddress = String(raw?.location?.locationEmailAddress ?? "").toLowerCase();
	const room =
		roomAddress && (raw?.location?.locationType === "conferenceRoom" || attendees.some((a) => a.address === roomAddress && a.type === "resource"))
			? { address: roomAddress, name: String(raw?.location?.displayName ?? roomAddress) }
			: undefined;
	return {
		...base,
		...listExtras(raw, tz),
		calendarId,
		bodyHtml: String(raw?.body?.content ?? ""),
		attendees,
		organizerAddress,
		isOrganizer: raw?.isOrganizer !== false,
		responseStatus: String(raw?.responseStatus?.response ?? "none") as AttendeeResponse,
		kind: String(raw?.type ?? "singleInstance"),
		seriesMasterId: raw?.seriesMasterId ? String(raw.seriesMasterId) : undefined,
		recurrence: rec.recurrence,
		recurrenceUntil: rec.until,
		recurrenceLabel: rec.label,
		isOnlineMeeting: !!raw?.isOnlineMeeting,
		joinUrl: raw?.onlineMeeting?.joinUrl ? String(raw.onlineMeeting.joinUrl) : undefined,
		isPrivate: raw?.sensitivity === "private",
		reminderMinutes: raw?.isReminderOn ? Number(raw?.reminderMinutesBeforeStart ?? 15) : null,
		categories: Array.isArray(raw?.categories) ? raw.categories.map(String) : [],
		room,
		allowNewTimeProposals: raw?.allowNewTimeProposals !== false,
		attachments: [],
		timeZone: tz,
	};
}

/** Detail d'un evenement ; une occurrence porte la recurrence de sa serie ; pieces jointes listees. */
export async function getEvent(cfg: GraphConfig, mailbox: string, id: string, calendarId?: string, tz: string = AGENDA_TIMEZONE): Promise<EventDetail> {
	const raw = await graph(cfg, mailbox, "GET", `/events/${ref(id)}`, undefined, "Événement", tz);
	if (raw?.seriesMasterId && !raw.recurrence) {
		const master = await graph(cfg, mailbox, "GET", `/events/${ref(raw.seriesMasterId)}?$select=recurrence`, undefined, "Série", tz).catch(() => null);
		if (master?.recurrence) raw.recurrence = master.recurrence;
	}
	const d = toEventDetail(raw, calendarId, tz);
	if (!d) throw new AgendaError("Événement illisible ou annulé.");
	if (raw?.hasAttachments) d.attachments = await listAttachments(cfg, mailbox, id).catch(() => []);
	return d;
}

// ---------------------------------------------------------------------------
// Pieces jointes
// ---------------------------------------------------------------------------

export async function listAttachments(cfg: GraphConfig, mailbox: string, eventId: string): Promise<EventAttachment[]> {
	const data = await graph(cfg, mailbox, "GET", `/events/${ref(eventId)}/attachments?$select=id,name,size,contentType,isInline`, undefined, "Pièce jointe");
	return (Array.isArray(data?.value) ? data.value : []).map((a: any) => ({
		id: String(a.id),
		name: String(a.name ?? "pièce jointe"),
		size: Number(a.size ?? 0),
		contentType: String(a.contentType ?? "application/octet-stream"),
		isInline: !!a.isInline,
	}));
}

/** Contenu d'une piece jointe (fichier), en base64. */
export async function getAttachment(cfg: GraphConfig, mailbox: string, eventId: string, attachmentId: string): Promise<NewAttachment> {
	const a = await graph(cfg, mailbox, "GET", `/events/${ref(eventId)}/attachments/${ref(attachmentId)}`, undefined, "Pièce jointe");
	if (typeof a?.contentBytes !== "string") throw new AgendaError("Cette pièce jointe n'est pas un fichier (élément Outlook ou lien) : ouvrez-la dans Outlook.");
	return { name: String(a.name ?? "piece-jointe"), contentType: String(a.contentType ?? "application/octet-stream"), base64: a.contentBytes };
}

const UPLOAD_CHUNK = 320 * 1024 * 10; // multiple de 320 Kio, sous 4 Mo

/**
 * Joint un fichier a l'evenement : envoi direct jusqu'a 3 Mo, session d'envoi au-dela
 * (morceaux de 3,1 Mo, comme le demande Graph).
 */
export async function addAttachment(cfg: GraphConfig, mailbox: string, eventId: string, file: NewAttachment): Promise<void> {
	const name = clip(file.name, 255) || "piece-jointe";
	const contentType = clip(file.contentType, 255) || "application/octet-stream";
	const bytes = Buffer.from(String(file.base64 ?? ""), "base64");
	if (!bytes.length) throw new AgendaError(`Fichier vide : ${name}.`);
	if (bytes.length > ATTACHMENT_MAX_BYTES) throw new AgendaError(`${name} dépasse 25 Mo.`);
	if (bytes.length <= 3 * 1024 * 1024) {
		await graph(cfg, mailbox, "POST", `/events/${ref(eventId)}/attachments`, { "@odata.type": "#microsoft.graph.fileAttachment", name, contentType, contentBytes: bytes.toString("base64") }, "Pièce jointe");
		return;
	}
	const session = await graph(cfg, mailbox, "POST", `/events/${ref(eventId)}/attachments/createUploadSession`, { AttachmentItem: { attachmentType: "file", name, size: bytes.length, contentType } }, "Pièce jointe");
	const url = String(session?.uploadUrl ?? "");
	if (!url.startsWith("https://")) throw new AgendaError("Envoi de la pièce jointe refusé par Microsoft Graph.");
	for (let at = 0; at < bytes.length; at += UPLOAD_CHUNK) {
		const part = bytes.subarray(at, Math.min(at + UPLOAD_CHUNK, bytes.length));
		// L'URL de session porte son propre jeton : pas d'en-tete d'autorisation.
		const res = await (cfg.fetchImpl ?? fetch)(url, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream", "content-length": String(part.length), "content-range": `bytes ${at}-${at + part.length - 1}/${bytes.length}` },
			body: part,
		});
		if (!res.ok) throw new AgendaError(`Envoi de ${name} interrompu (HTTP ${res.status}).`);
	}
}

export async function removeAttachment(cfg: GraphConfig, mailbox: string, eventId: string, attachmentId: string): Promise<void> {
	await graph(cfg, mailbox, "DELETE", `/events/${ref(eventId)}/attachments/${ref(attachmentId)}`, undefined, "Pièce jointe").catch((err) => {
		if (err instanceof AgendaError && /introuvable/.test(err.message)) return;
		throw err;
	});
}

/**
 * Cree l'evenement (invitations envoyees aux participants par Microsoft). Avec des pieces
 * jointes et des participants : cree sans participants, joint les fichiers, puis ajoute les
 * participants, pour que l'invitation parte avec les pieces jointes.
 */
export async function createEvent(cfg: GraphConfig, mailbox: string, input: EventInput, attachments: NewAttachment[] = []): Promise<EventDetail> {
	const path = input.calendarId ? `/calendars/${ref(input.calendarId)}/events` : "/events";
	const tz = input.timeZone ?? AGENDA_TIMEZONE;
	const payload = graphEventPayload(input);
	const later = attachments.length > 0 && input.attendees.length > 0;
	if (later) payload.attendees = [];
	const raw = await graph(cfg, mailbox, "POST", path, payload, "Agenda", tz);
	const d = toEventDetail(raw, input.calendarId, tz);
	if (!d) throw new AgendaError("Événement créé mais illisible : actualisez l'agenda.");
	for (const f of attachments) await addAttachment(cfg, mailbox, d.id, f);
	if (later) {
		await graph(cfg, mailbox, "PATCH", `/events/${ref(d.id)}`, { attendees: graphEventPayload(input).attendees }, "Événement", tz);
	}
	return d;
}

/**
 * Modifie l'evenement : une occurrence seule, ou toute la serie (l'id de la serie, avec sa
 * recurrence). Les participants recoivent la mise a jour.
 */
export async function updateEvent(cfg: GraphConfig, mailbox: string, id: string, input: EventInput, scope: EventScope = "occurrence", seriesMasterId?: string): Promise<void> {
	if (scope === "series" && seriesMasterId) {
		// Toute la serie : les heures saisies s'appliquent a partir du premier jour de la serie
		// (et la repetition repart de ce jour), pas de la date de l'occurrence ouverte.
		const master = await graph(cfg, mailbox, "GET", `/events/${ref(seriesMasterId)}?$select=start,end,isAllDay`, undefined, "Série", input.timeZone ?? AGENDA_TIMEZONE);
		const first = String(master?.start?.dateTime ?? "").slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new AgendaError("Série illisible dans Outlook.");
		const span = Math.round((Date.parse(`${input.end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${input.start.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
		const shifted: EventInput = {
			...input,
			start: input.allDay ? first : `${first}${input.start.slice(10)}`,
			end: input.allDay ? addDays(first, span) : `${addDays(first, span)}${input.end.slice(10)}`,
		};
		await graph(cfg, mailbox, "PATCH", `/events/${ref(seriesMasterId)}`, graphEventPayload(shifted, { update: true, recurrence: true }), "Série", input.timeZone ?? AGENDA_TIMEZONE);
		return;
	}
	// Occurrence d'une serie : jamais de recurrence sur une occurrence.
	await graph(cfg, mailbox, "PATCH", `/events/${ref(id)}`, graphEventPayload(input, { update: true, recurrence: !seriesMasterId }), "Événement", input.timeZone ?? AGENDA_TIMEZONE);
}

/** Deplace l'evenement (glisser-deposer, redimensionnement, proposition d'horaire acceptee). */
export async function moveEvent(cfg: GraphConfig, mailbox: string, id: string, allDay: boolean, start: string, end: string, tz: string = AGENDA_TIMEZONE): Promise<void> {
	await graph(cfg, mailbox, "PATCH", `/events/${ref(id)}`, graphMovePayload(allDay, start, end, tz), "Événement", tz);
}

/**
 * Supprime l'evenement. Reunion que j'organise avec des participants : annulation (ils la
 * recoivent, avec le mot facultatif). Invitation recue : refus envoye a l'organisateur puis
 * retrait de mon agenda, comme le bouton Supprimer d'Outlook.
 */
export async function deleteEvent(
	cfg: GraphConfig,
	mailbox: string,
	id: string,
	opts: { isOrganizer: boolean; hasAttendees: boolean; comment?: string } = { isOrganizer: true, hasAttendees: false },
): Promise<void> {
	const comment = clip(opts.comment, 2000);
	if (opts.isOrganizer && opts.hasAttendees) {
		await graph(cfg, mailbox, "POST", `/events/${ref(id)}/cancel`, { comment }, "Événement");
		return;
	}
	if (!opts.isOrganizer) {
		await graph(cfg, mailbox, "POST", `/events/${ref(id)}/decline`, { comment, sendResponse: true }, "Événement").catch(() => null);
	}
	await graph(cfg, mailbox, "DELETE", `/events/${ref(id)}`, undefined, "Événement").catch((err) => {
		// deja retire par le refus : rien a faire
		if (err instanceof AgendaError && /introuvable/.test(err.message)) return;
		throw err;
	});
}

export type InviteResponse = "accept" | "tentativelyAccept" | "decline";

/**
 * Repond a une invitation (l'organisateur recoit la reponse). Provisoire ou refus peuvent
 * proposer un autre horaire (Outlook le montre a l'organisateur, qui l'accepte ou non).
 */
export async function respondToEvent(
	cfg: GraphConfig,
	mailbox: string,
	id: string,
	response: InviteResponse,
	comment?: string,
	proposed?: { start: string; end: string },
	tz: string = AGENDA_TIMEZONE,
): Promise<void> {
	if (!["accept", "tentativelyAccept", "decline"].includes(response)) throw new AgendaError("Réponse invalide.");
	const body: Record<string, unknown> = { comment: clip(comment, 2000), sendResponse: true };
	if (proposed) {
		if (response === "accept") throw new AgendaError("Un autre horaire se propose avec « Provisoire » ou « Refuser ».");
		const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
		if (!re.test(proposed.start) || !re.test(proposed.end) || proposed.end <= proposed.start) throw new AgendaError("Horaire proposé invalide.");
		body.proposedNewTime = { start: { dateTime: `${proposed.start}:00`, timeZone: tz }, end: { dateTime: `${proposed.end}:00`, timeZone: tz } };
	}
	await graph(cfg, mailbox, "POST", `/events/${ref(id)}/${response}`, body, "Invitation", tz);
}

/** Transfere l'invitation a d'autres personnes (l'organisateur en est informe par Microsoft). */
export async function forwardEvent(cfg: GraphConfig, mailbox: string, id: string, to: string[], comment?: string): Promise<void> {
	const list = [...new Set(to.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
	if (!list.length) throw new AgendaError("Indiquez au moins un destinataire.");
	const bad = list.find((a) => !EMAIL_RE.test(a));
	if (bad) throw new AgendaError(`Adresse invalide : ${bad}`);
	await graph(cfg, mailbox, "POST", `/events/${ref(id)}/forward`, { ToRecipients: list.slice(0, 100).map((address) => ({ EmailAddress: { Address: address, Name: address } })), Comment: clip(comment, 2000) }, "Événement");
}

// ---------------------------------------------------------------------------
// Rappels
// ---------------------------------------------------------------------------

export type DueReminder = {
	eventId: string;
	title: string;
	start: string;
	end: string;
	location?: string;
	webLink?: string;
	joinUrl?: string;
	/** Heure de declenchement ("YYYY-MM-DDTHH:mm", fuseau d'affichage). */
	fireAt: string;
};

/**
 * Rappels des evenements qui commencent entre `from` et `to` ("YYYY-MM-DDTHH:mm"), tels
 * qu'Outlook les tient (reminderView : rappels deja fermes ou repousses dans Outlook compris).
 */
export async function listReminders(cfg: GraphConfig, mailbox: string, from: string, to: string, tz: string = AGENDA_TIMEZONE): Promise<DueReminder[]> {
	const path = `/reminderView(startDateTime='${from}:00',endDateTime='${to}:00')`;
	const data = await graph(cfg, mailbox, "GET", path, undefined, "Rappel", tz);
	return (Array.isArray(data?.value) ? data.value : [])
		.map((r: any) => ({
			eventId: String(r.eventId ?? ""),
			title: String(r.eventSubject ?? "").trim() || "(Sans titre)",
			start: graphZoned(r.eventStartTime, tz),
			end: graphZoned(r.eventEndTime, tz),
			location: String(r.eventLocation?.displayName ?? "").trim() || undefined,
			webLink: r.eventWebLink ? String(r.eventWebLink) : undefined,
			fireAt: graphZoned(r.reminderFireTime, tz),
		}))
		.filter((r: DueReminder) => r.eventId && r.start && r.fireAt);
}

/** Ferme le rappel dans Outlook aussi. */
export async function dismissReminder(cfg: GraphConfig, mailbox: string, id: string): Promise<void> {
	await graph(cfg, mailbox, "POST", `/events/${ref(id)}/dismissReminder`, {}, "Rappel");
}

/** Repousse le rappel ("YYYY-MM-DDTHH:mm" dans le fuseau donne), dans Outlook aussi. */
export async function snoozeReminder(cfg: GraphConfig, mailbox: string, id: string, at: string, tz: string = AGENDA_TIMEZONE): Promise<void> {
	await graph(cfg, mailbox, "POST", `/events/${ref(id)}/snoozeReminder`, { newReminderTime: { dateTime: `${at}:00`, timeZone: tz } }, "Rappel", tz);
}

/** Lien Teams d'un evenement (pour le bouton « Rejoindre » d'un rappel). */
export async function eventJoinUrl(cfg: GraphConfig, mailbox: string, id: string): Promise<string | undefined> {
	const raw = await graph(cfg, mailbox, "GET", `/events/${ref(id)}?$select=onlineMeeting`, undefined, "Événement").catch(() => null);
	return raw?.onlineMeeting?.joinUrl ? String(raw.onlineMeeting.joinUrl) : undefined;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Couleurs des categories Outlook (preset0 a preset24). */
export const CATEGORY_COLORS: Record<string, string> = {
	preset0: "#e74856",
	preset1: "#f7630c",
	preset2: "#8e562e",
	preset3: "#ffb900",
	preset4: "#16c60c",
	preset5: "#00b7c3",
	preset6: "#98a660",
	preset7: "#0078d4",
	preset8: "#8764b8",
	preset9: "#c239b3",
	preset10: "#7a8c9c",
	preset11: "#4a5a6a",
	preset12: "#a0a0a0",
	preset13: "#5c5c5c",
	preset14: "#2b2b2b",
	preset15: "#a4262c",
	preset16: "#ca5010",
	preset17: "#603d30",
	preset18: "#c19c00",
	preset19: "#107c10",
	preset20: "#038387",
	preset21: "#5b6b29",
	preset22: "#004e8c",
	preset23: "#5c2e91",
	preset24: "#881798",
};

export const categoryColor = (preset: string) => CATEGORY_COLORS[preset] ?? "#9aa0a6";

const NEED_CATEGORIES: GraphNeed = { permission: "permission applicative MailboxSettings.ReadWrite à accorder pour les catégories" };

export async function listCategories(cfg: GraphConfig, mailbox: string): Promise<OutlookCategory[]> {
	const data = await graph(cfg, mailbox, "GET", "/outlook/masterCategories", undefined, "Catégorie", AGENDA_TIMEZONE, NEED_CATEGORIES);
	return (Array.isArray(data?.value) ? data.value : []).map((c: any) => ({
		id: String(c.id),
		name: String(c.displayName ?? ""),
		preset: String(c.color ?? "none"),
		color: categoryColor(String(c.color ?? "none")),
	}));
}

/** Ajoute une categorie a la liste principale (couleur suivante libre). */
export async function createCategory(cfg: GraphConfig, mailbox: string, name: string, preset?: string): Promise<OutlookCategory> {
	const displayName = clip(name, 255);
	if (!displayName) throw new AgendaError("Nom de catégorie vide.");
	const color = preset && CATEGORY_COLORS[preset] ? preset : "preset7";
	const c = await graph(cfg, mailbox, "POST", "/outlook/masterCategories", { displayName, color }, "Catégorie", AGENDA_TIMEZONE, NEED_CATEGORIES);
	return { id: String(c?.id ?? displayName), name: displayName, preset: color, color: categoryColor(color) };
}

// ---------------------------------------------------------------------------
// Salles
// ---------------------------------------------------------------------------

/** Salles de reunion du tenant (Places). */
export async function listRooms(cfg: GraphConfig): Promise<Room[]> {
	const data = await graphUrl(cfg, `${GRAPH}/places/microsoft.graph.room?$top=200`, "GET", undefined, "Salle", AGENDA_TIMEZONE, {
		permission: "permission applicative Place.Read.All à accorder pour la liste des salles",
	});
	return (Array.isArray(data?.value) ? data.value : [])
		.map((r: any) => ({
			address: String(r.emailAddress ?? "").toLowerCase(),
			name: String(r.displayName ?? r.emailAddress ?? ""),
			capacity: Number.isFinite(Number(r.capacity)) && r.capacity ? Number(r.capacity) : undefined,
			building: r.building ? String(r.building) : undefined,
			floor: r.floorLabel ? String(r.floorLabel) : r.floorNumber != null ? String(r.floorNumber) : undefined,
		}))
		.filter((r: Room) => r.address)
		.sort((a: Room, b: Room) => a.name.localeCompare(b.name, "fr"));
}

// ---------------------------------------------------------------------------
// Disponibilites (assistant de planification)
// ---------------------------------------------------------------------------

export type Schedule = { address: string; busy: BusyBlock[]; error?: string };

/**
 * Plages occupees de chaque personne ou salle entre `from` et `to` ("YYYY-MM-DDTHH:mm",
 * fuseau `tz`). Seul le statut est rendu (occupe, provisoire, absent...), jamais l'objet : la
 * disponibilite est ce qu'Outlook montre a tout le monde dans l'assistant.
 */
export async function getSchedules(cfg: GraphConfig, mailbox: string, addresses: string[], from: string, to: string, tz: string = AGENDA_TIMEZONE): Promise<Schedule[]> {
	const list = [...new Set(addresses.map((a) => String(a).trim().toLowerCase()).filter((a) => EMAIL_RE.test(a)))].slice(0, 50);
	if (!list.length) return [];
	const data = await graph(
		cfg,
		mailbox,
		"POST",
		"/calendar/getSchedule",
		{ schedules: list, startTime: { dateTime: `${from}:00`, timeZone: tz }, endTime: { dateTime: `${to}:00`, timeZone: tz }, availabilityViewInterval: 15 },
		"Disponibilités",
		tz,
	);
	const byAddress = new Map<string, Schedule>();
	for (const s of Array.isArray(data?.value) ? data.value : []) {
		const address = String(s?.scheduleId ?? "").toLowerCase();
		if (!address) continue;
		const busy: BusyBlock[] = (Array.isArray(s?.scheduleItems) ? s.scheduleItems : [])
			.map((it: any) => ({ start: graphZoned(it.start, tz), end: graphZoned(it.end, tz), status: String(it.status ?? "busy") }))
			.filter((b: BusyBlock) => b.start && b.end && b.status !== "free");
		byAddress.set(address, { address, busy, error: s?.error?.message ? "Disponibilités non communiquées" : undefined });
	}
	return list.map((address) => byAddress.get(address) ?? { address, busy: [], error: "Disponibilités non communiquées" });
}

// ---------------------------------------------------------------------------
// Options des reunions Teams
// ---------------------------------------------------------------------------

export type TeamsLobby = "everyone" | "organization" | "organizationAndFederated" | "invited" | "organizer";
export type TeamsPresenters = "everyone" | "organization" | "roleIsPresenter" | "organizer";
export type TeamsChat = "enabled" | "disabled" | "limited";
export type TeamsOptions = {
	meetingId: string;
	lobby: TeamsLobby;
	dialInBypassLobby: boolean;
	presenters: TeamsPresenters;
	chat: TeamsChat;
	camera: boolean;
	mic: boolean;
	recordAutomatically: boolean;
	announceEntryExit: boolean;
};

export const TEAMS_LOBBY: { value: TeamsLobby; label: string }[] = [
	{ value: "everyone", label: "Tout le monde" },
	{ value: "organizationAndFederated", label: "Mon organisation et organisations approuvées" },
	{ value: "organization", label: "Mon organisation" },
	{ value: "invited", label: "Personnes invitées" },
	{ value: "organizer", label: "Moi seulement (organisateur)" },
];
export const TEAMS_PRESENTERS: { value: TeamsPresenters; label: string }[] = [
	{ value: "everyone", label: "Tout le monde" },
	{ value: "organization", label: "Mon organisation" },
	{ value: "roleIsPresenter", label: "Personnes désignées" },
	{ value: "organizer", label: "Moi seulement" },
];
export const TEAMS_CHAT: { value: TeamsChat; label: string }[] = [
	{ value: "enabled", label: "Activée" },
	{ value: "limited", label: "Pendant la réunion seulement" },
	{ value: "disabled", label: "Désactivée" },
];

const NEED_TEAMS: GraphNeed = {
	permission:
		"permission applicative OnlineMeetings.ReadWrite.All et stratégie d'accès Teams de l'application (New-CsApplicationAccessPolicy / Grant-CsApplicationAccessPolicy) à configurer",
};

function toTeamsOptions(m: any): TeamsOptions {
	return {
		meetingId: String(m.id),
		lobby: (TEAMS_LOBBY.some((x) => x.value === m?.lobbyBypassSettings?.scope) ? m.lobbyBypassSettings.scope : "organization") as TeamsLobby,
		dialInBypassLobby: !!m?.lobbyBypassSettings?.isDialInBypassEnabled,
		presenters: (TEAMS_PRESENTERS.some((x) => x.value === m?.allowedPresenters) ? m.allowedPresenters : "everyone") as TeamsPresenters,
		chat: (TEAMS_CHAT.some((x) => x.value === m?.allowMeetingChat) ? m.allowMeetingChat : "enabled") as TeamsChat,
		camera: m?.allowAttendeeToEnableCamera !== false,
		mic: m?.allowAttendeeToEnableMic !== false,
		recordAutomatically: !!m?.recordAutomatically,
		announceEntryExit: !!m?.isEntryExitAnnounced,
	};
}

/** Options de la reunion Teams retrouvee par son lien (l'organisateur seulement). */
export async function getTeamsOptions(cfg: GraphConfig, mailbox: string, joinUrl: string): Promise<TeamsOptions> {
	const url = String(joinUrl ?? "");
	if (!url.startsWith("https://teams.microsoft.com/")) throw new AgendaError("Lien Teams invalide.");
	const filter = encodeURIComponent(`JoinWebUrl eq '${url.replace(/'/g, "''")}'`);
	const data = await graph(cfg, mailbox, "GET", `/onlineMeetings?$filter=${filter}`, undefined, "Réunion Teams", AGENDA_TIMEZONE, NEED_TEAMS);
	const m = Array.isArray(data?.value) ? data.value[0] : null;
	if (!m) throw new AgendaError("Réunion Teams introuvable : seules les réunions que vous organisez se règlent ici.");
	return toTeamsOptions(m);
}

export async function updateTeamsOptions(cfg: GraphConfig, mailbox: string, o: TeamsOptions): Promise<TeamsOptions> {
	if (!TEAMS_LOBBY.some((x) => x.value === o.lobby) || !TEAMS_PRESENTERS.some((x) => x.value === o.presenters) || !TEAMS_CHAT.some((x) => x.value === o.chat)) {
		throw new AgendaError("Options Teams invalides.");
	}
	const m = await graph(
		cfg,
		mailbox,
		"PATCH",
		`/onlineMeetings/${ref(o.meetingId)}`,
		{
			lobbyBypassSettings: { scope: o.lobby, isDialInBypassEnabled: !!o.dialInBypassLobby },
			allowedPresenters: o.presenters,
			allowMeetingChat: o.chat,
			allowAttendeeToEnableCamera: !!o.camera,
			allowAttendeeToEnableMic: !!o.mic,
			recordAutomatically: !!o.recordAutomatically,
			isEntryExitAnnounced: !!o.announceEntryExit,
		},
		"Réunion Teams",
		AGENDA_TIMEZONE,
		NEED_TEAMS,
	);
	return m ? toTeamsOptions(m) : o;
}

// ---------------------------------------------------------------------------
// Agendas des collegues
// ---------------------------------------------------------------------------
// L'application Graph lit tous les agendas du tenant : courrier n'en montre que ce qu'Outlook
// montrerait. Un agenda de collegue n'apparait que s'il est partage avec l'utilisateur (droit
// explicite ou droit par defaut « Mon organisation » dans les autorisations de son agenda), et
// son contenu est reduit selon ce droit : disponibilites seules, titre et lieu, ou detail ;
// les rendez-vous prives restent masques sauf delegation avec acces aux elements prives.

export type CalendarRole =
	| "none"
	| "freeBusyRead"
	| "limitedRead"
	| "read"
	| "write"
	| "delegateWithoutPrivateEventAccess"
	| "delegateWithPrivateEventAccess"
	| "custom";

const ROLE_RANK: Record<CalendarRole, number> = {
	none: 0,
	custom: 1,
	freeBusyRead: 1,
	limitedRead: 2,
	read: 3,
	write: 4,
	delegateWithoutPrivateEventAccess: 4,
	delegateWithPrivateEventAccess: 5,
};

export const ROLE_LABEL: Record<CalendarRole, string> = {
	none: "Aucun accès",
	custom: "Disponibilités",
	freeBusyRead: "Disponibilités",
	limitedRead: "Titres et lieux",
	read: "Lecture",
	write: "Modification",
	delegateWithoutPrivateEventAccess: "Délégué",
	delegateWithPrivateEventAccess: "Délégué (éléments privés)",
};

export const canSeeTitles = (role: CalendarRole) => ROLE_RANK[role] >= 2;
export const canSeeDetails = (role: CalendarRole) => ROLE_RANK[role] >= 3;
export const canEditRole = (role: CalendarRole) => ROLE_RANK[role] >= 4;
export const canSeePrivate = (role: CalendarRole) => role === "delegateWithPrivateEventAccess";

const asRole = (v: unknown): CalendarRole => (v && Object.hasOwn(ROLE_RANK, String(v)) ? (String(v) as CalendarRole) : "custom");

/**
 * Droit de `me` sur l'agenda par defaut de `owner` : son droit explicite, sinon celui de « Mon
 * organisation » (entree sans adresse, interne), sinon aucun.
 */
export async function calendarRole(cfg: GraphConfig, owner: string, me: string): Promise<CalendarRole> {
	if (owner.toLowerCase() === me.toLowerCase()) return "delegateWithPrivateEventAccess";
	const data = await graph(cfg, owner, "GET", "/calendar/calendarPermissions", undefined, "Agenda");
	const list: any[] = Array.isArray(data?.value) ? data.value : [];
	const mine = list.find((p) => String(p?.emailAddress?.address ?? "").toLowerCase() === me.toLowerCase());
	if (mine) return asRole(mine.role);
	const org = list.find((p) => !p?.emailAddress?.address && p?.isInsideOrganization);
	return org ? asRole(org.role) : "none";
}

/** Evenement d'un collegue reduit a ce que son droit laisse voir. */
export function redactForRole(e: CalendarEvent, role: CalendarRole): CalendarEvent {
	const out: CalendarEvent = { ...e };
	if (!canSeeTitles(role) || (e.isPrivate && !canSeePrivate(role))) {
		const label = e.isPrivate && canSeeTitles(role) ? "Rendez-vous privé" : (SHOW_AS.find((s) => s.value === e.showAs)?.label ?? "Occupé");
		out.title = label;
		delete out.location;
		delete out.organizer;
		delete out.joinUrl;
		delete out.webLink;
	}
	if (!canSeeDetails(role)) delete out.webLink;
	// Les propositions faites a un collegue ne regardent que lui.
	delete out.proposals;
	return out;
}

/** Agendas partages avec la boite (entrees ajoutees dans Outlook dont le proprietaire est un autre). */
export async function sharedCalendarOwners(cfg: GraphConfig, mailbox: string): Promise<{ address: string; name: string }[]> {
	const data = await graph(cfg, mailbox, "GET", "/calendars?$select=id,name,owner&$top=100", undefined, "Agenda");
	const seen = new Set<string>();
	const out: { address: string; name: string }[] = [];
	for (const c of Array.isArray(data?.value) ? data.value : []) {
		const address = String(c?.owner?.address ?? "").toLowerCase();
		if (!address || address === mailbox.toLowerCase() || seen.has(address)) continue;
		seen.add(address);
		out.push({ address, name: String(c?.owner?.name ?? c?.name ?? address) });
	}
	return out;
}
