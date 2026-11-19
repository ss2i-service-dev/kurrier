// ss2i : mode demo de l'agenda Outlook, pour voir et essayer la page Agenda et la
// planification de « Ajouter a l'agenda » en dev sans Microsoft Graph ni API Anthropic. Actif
// seulement hors production et avec OUTLOOK_CALENDAR_DEMO=1 : jamais en image deployee.
// Rendez-vous fictifs calcules a partir des dates puis gardes en memoire du processus, si
// bien que creation, modification, deplacement, suppression et reponses s'y voient comme
// dans Outlook (perdus au redemarrage). Deux agendas a soi, trois collegues aux droits
// differents (lecture, disponibilites seules, delegation).
import { type AgendaEvent, addDays } from "@common/thread-agenda";
import { type CalendarEvent, convertZone, dayList, mondayOf, todayInParis, weekday } from "@common/outlook-calendar";
import {
	type CalendarRole,
	type DueReminder,
	type EventAttachment,
	type EventDetail,
	type EventInput,
	type EventScope,
	type InviteResponse,
	type NewAttachment,
	type OutlookCalendar,
	type OutlookCategory,
	type Room,
	type Schedule,
	type TeamsOptions,
	categoryColor,
} from "@common/outlook-graph";
import { AGENDA_TIMEZONE, AgendaError } from "@common/thread-agenda";
import type { ReminderSource } from "@common/meeting-reminders";

const on = () => process.env.NODE_ENV !== "production" && process.env.OUTLOOK_CALENDAR_DEMO === "1";

/** Ancien nom, garde pour thread-agenda. */
export const outlookDemo = on;

type Tpl = {
	day: number;
	start: string;
	end: string;
	title: string;
	location?: string;
	showAs?: string;
	attendees?: string[];
	organizer?: string;
	teams?: boolean;
	weekly?: boolean;
	private?: boolean;
	odd?: boolean;
	categories?: string[];
	/** Un participant propose un autre horaire (decalage en minutes). */
	proposeShift?: number;
	room?: string;
};

const ME = "moi";

const TEMPLATES: Record<string, Tpl[]> = {
	"own:cal-main": [
		{ day: 1, start: "09:30", end: "10:00", title: "Point d'équipe", teams: true, attendees: ["samuel@ss2i-digital.fr", "jb@ss2i-digital.fr"], weekly: true },
		{ day: 1, start: "14:00", end: "15:30", title: "Atelier Cerise", categories: ["Projet Cerise"], room: "salle-atlantique@ss2i-digital.fr" },
		{ day: 2, start: "10:00", end: "11:00", title: "Démo client OptiMarché", location: "Visio", organizer: "samuel@ss2i-digital.fr", teams: true, attendees: ["laurence@optimarche.fr"] },
		{ day: 2, start: "10:30", end: "11:15", title: "Appel Laurence", showAs: "tentative" },
		{ day: 2, start: "14:00", end: "16:00", title: "Comité de pilotage", organizer: "jb@ss2i-digital.fr", attendees: ["samuel@ss2i-digital.fr"], odd: true },
		{ day: 3, start: "09:00", end: "12:00", title: "Dév kurrier" },
		{ day: 3, start: "16:00", end: "16:30", title: "Point Samuel", attendees: ["samuel@ss2i-digital.fr"], proposeShift: 60 },
		{ day: 4, start: "11:00", end: "12:00", title: "Revue de sprint", teams: true, attendees: ["samuel@ss2i-digital.fr", "jb@ss2i-digital.fr"] },
		{ day: 4, start: "12:30", end: "13:30", title: "Déjeuner", showAs: "free", private: true },
		{ day: 5, start: "15:00", end: "17:00", title: "Recette Docator", location: "Bureau", categories: ["Client"] },
	],
	"own:cal-projets": [{ day: 5, start: "", end: "", title: "Livraison Docator", odd: true }],
	"colleague:samuel@ss2i-digital.fr": [
		{ day: 1, start: "09:30", end: "10:00", title: "Point d'équipe", teams: true },
		{ day: 2, start: "10:00", end: "11:00", title: "Démo client OptiMarché", location: "Visio" },
		{ day: 3, start: "13:30", end: "15:00", title: "Rendez-vous banque", private: true },
		{ day: 4, start: "09:00", end: "12:00", title: "Avant-vente Thermes de Saujon", location: "Saujon" },
		{ day: 5, start: "10:00", end: "12:00", title: "Entretien candidat" },
	],
	"colleague:jb@ss2i-digital.fr": [
		{ day: 1, start: "10:00", end: "12:00", title: "Intervention client" },
		{ day: 2, start: "14:00", end: "16:00", title: "Comité de pilotage" },
		{ day: 4, start: "14:00", end: "17:30", title: "Formation" },
	],
	"colleague:dev@ss2i-digital.fr": [
		{ day: 3, start: "10:00", end: "11:00", title: "Mise en production" },
		{ day: 5, start: "16:00", end: "17:00", title: "Revue de code" },
	],
};

const CALENDARS: OutlookCalendar[] = [
	{ id: "cal-main", name: "Calendrier", color: "#4f8de8", isDefault: true, canEdit: true },
	{ id: "cal-projets", name: "Projets", color: "#f0a14b", isDefault: false, canEdit: true },
];

const ROOMS: Room[] = [
	{ address: "salle-atlantique@ss2i-digital.fr", name: "Salle Atlantique", capacity: 10, building: "La Rochelle", floor: "1" },
	{ address: "salle-ocean@ss2i-digital.fr", name: "Salle Océan", capacity: 4, building: "La Rochelle", floor: "RDC" },
	{ address: "bulle-visio@ss2i-digital.fr", name: "Bulle visio", capacity: 2, building: "La Rochelle", floor: "1" },
];

// Plages occupees fictives des salles et des personnes hors agendas partages (jour de semaine -> [debut, fin]).
const BUSY: Record<string, [number, string, string][]> = {
	"salle-atlantique@ss2i-digital.fr": [[1, "14:00", "15:30"], [2, "09:00", "12:00"], [4, "14:00", "17:00"]],
	"salle-ocean@ss2i-digital.fr": [[2, "10:00", "11:00"], [3, "15:00", "16:00"]],
	"bulle-visio@ss2i-digital.fr": [[1, "11:00", "12:00"], [5, "09:30", "10:30"]],
	"laurence@optimarche.fr": [[1, "09:00", "12:00"], [3, "14:00", "18:00"], [4, "09:00", "10:30"]],
};

const categories: OutlookCategory[] = [
	{ id: "c1", name: "Client", preset: "preset4", color: categoryColor("preset4") },
	{ id: "c2", name: "Projet Cerise", preset: "preset8", color: categoryColor("preset8") },
	{ id: "c3", name: "Interne", preset: "preset7", color: categoryColor("preset7") },
	{ id: "c4", name: "Personnel", preset: "preset1", color: categoryColor("preset1") },
];

const attachmentStore = new Map<string, (EventAttachment & { base64: string })[]>();
const teams = new Map<string, TeamsOptions>();
const reminderState = new Map<string, { dismissed?: boolean; snoozedTo?: string }>();
// Rappels multiples des evenements crees depuis un fil (propriete ss2iReminders de Graph).
const reminderOffsets = new Map<string, number[]>();

const SHARED = [
	{ address: "samuel@ss2i-digital.fr", name: "Samuel Legros" },
	{ address: "jb@ss2i-digital.fr", name: "Jean-Baptiste" },
];

const ROLES: Record<string, CalendarRole> = {
	"samuel@ss2i-digital.fr": "read",
	"jb@ss2i-digital.fr": "freeBusyRead",
	"dev@ss2i-digital.fr": "write",
};

// Evenements materialises (par source), supprimes, et reponses donnees.
const store = new Map<string, Map<string, EventDetail>>();
const deleted = new Set<string>();
let seq = 0;

const isOdd = (d: string) => Math.round(Date.parse(`${mondayOf(d)}T00:00:00Z`) / (7 * 86_400_000)) % 2 === 1;

function bucket(key: string) {
	let b = store.get(key);
	if (!b) store.set(key, (b = new Map()));
	return b;
}

function fromTpl(key: string, owner: string, d: string, t: Tpl, i: number): EventDetail {
	const allDay = !t.start;
	const organizer = t.organizer ?? owner;
	const isOrganizer = organizer === owner;
	const attendees: EventDetail["attendees"] = (t.attendees ?? []).map((a) => ({
		address: a,
		type: "required" as const,
		response: (a.length % 3 === 0 ? "accepted" : a.length % 3 === 1 ? "tentativelyAccepted" : "none") as EventDetail["attendees"][number]["response"],
	}));
	if (t.proposeShift && attendees[0] && t.start) {
		const sh = (v: string) => {
			const m = Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) + (t.proposeShift ?? 0);
			return `${d}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
		};
		attendees[0] = { ...attendees[0], response: "tentativelyAccepted", proposed: { start: sh(t.start), end: sh(t.end) } };
	}
	const room = t.room ? ROOMS.find((r) => r.address === t.room) : undefined;
	if (room) attendees.push({ address: room.address, name: room.name, type: "resource", response: "accepted" });
	if (!isOrganizer) attendees.unshift({ address: owner, type: "required", response: "notResponded" });
	return {
		id: `${key}|${d}|${i}`,
		title: t.title,
		allDay,
		start: allDay ? d : `${d}T${t.start}`,
		end: allDay ? d : `${d}T${t.end}`,
		location: room?.name ?? t.location,
		room: room ? { address: room.address, name: room.name } : undefined,
		showAs: t.showAs ?? (allDay ? "free" : "busy"),
		organizer: isOrganizer ? undefined : organizer,
		organizerAddress: organizer,
		isOrganizer,
		responseStatus: isOrganizer ? "organizer" : "notResponded",
		attendees,
		bodyHtml: t.teams ? "<p>Ordre du jour : à préciser.</p>" : "",
		kind: t.weekly ? "occurrence" : "singleInstance",
		seriesMasterId: t.weekly ? `${key}|series|${i}` : undefined,
		recurrence: t.weekly ? "weekly" : "none",
		recurrenceLabel: t.weekly ? "Toutes les semaines" : undefined,
		recurring: !!t.weekly,
		isOnlineMeeting: !!t.teams,
		joinUrl: t.teams ? "https://teams.microsoft.com/l/meetup-join/demo" : undefined,
		isPrivate: !!t.private,
		reminderMinutes: allDay ? null : 15,
		categories: t.categories ?? [],
		allowNewTimeProposals: true,
		attachments: [],
		timeZone: AGENDA_TIMEZONE,
		webLink: "https://outlook.office.com/calendar/",
	};
}

function materialize(key: string, owner: string, from: string, to: string) {
	const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
	const b = bucket(key);
	for (const d of dayList(from, n)) {
		(TEMPLATES[key] ?? []).forEach((t, i) => {
			if (t.day !== weekday(d) || (t.odd && !isOdd(d))) return;
			const id = `${key}|${d}|${i}`;
			if (!b.has(id) && !deleted.has(id)) b.set(id, fromTpl(key, owner, d, t, i));
		});
	}
}

const inRange = (e: CalendarEvent, from: string, to: string) =>
	e.allDay ? e.end >= from && e.start < to : e.start.slice(0, 10) < to && e.end.slice(0, 10) >= from;

function find(key: string, id: string): EventDetail {
	const e = bucket(key).get(id);
	if (!e) throw new AgendaError("Événement introuvable dans Outlook (supprimé entre-temps ?).");
	return e;
}

// Le magasin de demo garde les heures de Paris ; lecture et ecriture dans le fuseau d'affichage.
const toParis = (v: string, tz: string) => (v.length > 10 ? convertZone(v, tz, AGENDA_TIMEZONE) : v);
const fromParis = <T extends { allDay: boolean; start: string; end: string }>(e: T, tz: string): T =>
	e.allDay || tz === AGENDA_TIMEZONE ? e : { ...e, start: convertZone(e.start, AGENDA_TIMEZONE, tz), end: convertZone(e.end, AGENDA_TIMEZONE, tz) };

function apply(e: EventDetail, i: EventInput): EventDetail {
	const tz = i.timeZone ?? AGENDA_TIMEZONE;
	return {
		...e,
		title: i.title,
		allDay: i.allDay,
		start: toParis(i.start, tz),
		end: toParis(i.end, tz),
		location: i.room?.name ?? i.location,
		room: i.room,
		categories: i.categories ?? [],
		allowNewTimeProposals: i.allowNewTimeProposals !== false,
		showAs: i.showAs,
		isPrivate: i.isPrivate,
		reminderMinutes: i.reminderMinutes,
		attendees: i.attendees.map((a) => ({ ...a, response: e.attendees.find((x) => x.address === a.address)?.response ?? "none" })),
		bodyHtml: i.notesChanged ? (i.notes ?? "").split("\n").map((l) => `<p>${l.replace(/</g, "&lt;")}</p>`).join("") : e.bodyHtml,
		isOnlineMeeting: e.isOnlineMeeting || i.online,
		joinUrl: e.joinUrl ?? (i.online ? "https://teams.microsoft.com/l/meetup-join/demo" : undefined),
		recurrence: i.recurrence,
		recurring: i.recurrence !== "none",
		recurrenceLabel: i.recurrence !== "none" ? "Répétition (démo : seule cette date est affichée)" : undefined,
	};
}

export const demo = {
	on,
	calendars: () => CALENDARS,
	shared: () => SHARED,
	role: (owner: string, _me: string): CalendarRole => ROLES[owner] ?? "none",
	events(key: string, owner: string, from: string, to: string, tz: string = AGENDA_TIMEZONE): CalendarEvent[] {
		const k = key === "own:default" ? "own:cal-main" : key;
		materialize(k, owner, addDaysSafe(from, -1), addDaysSafe(to, 1));
		if (k === "own:cal-main") liveMeeting(owner);
		return [...bucket(k).values()]
			.map((e) => {
				const proposals = e.isOrganizer
					? e.attendees
							.filter((a) => a.proposed)
							.map((a) => ({ address: a.address, name: a.name, ...fromParis({ allDay: false, ...(a.proposed as { start: string; end: string }) }, tz) }))
							.map(({ allDay: _x, ...p }) => p)
					: [];
				return { ...fromParis(e, tz), hasAttachments: (attachmentStore.get(e.id)?.length ?? 0) > 0, proposals: proposals.length ? proposals : undefined };
			})
			.filter((e) => inRange(e, from, to));
	},
	get(key: string, id: string, tz: string = AGENDA_TIMEZONE): EventDetail {
		const e = find(key === "own:default" ? "own:cal-main" : key, id);
		const shifted = fromParis(e, tz);
		return {
			...shifted,
			timeZone: tz,
			attendees: e.attendees.map((a) => (a.proposed ? { ...a, proposed: fromParis({ allDay: false, ...a.proposed }, tz) } : a)),
			attachments: (attachmentStore.get(e.id) ?? []).map(({ base64: _b, ...a }) => a),
		};
	},
	create(key: string, owner: string, i: EventInput): string {
		const id = `${key}|new|${++seq}`;
		const base: EventDetail = {
			id,
			title: i.title,
			allDay: i.allDay,
			start: i.start,
			end: i.end,
			isOrganizer: true,
			responseStatus: "organizer",
			organizerAddress: owner,
			attendees: [],
			bodyHtml: "",
			kind: "singleInstance",
			recurrence: "none",
			isOnlineMeeting: false,
			isPrivate: false,
			reminderMinutes: null,
			categories: [],
			allowNewTimeProposals: true,
			attachments: [],
			timeZone: AGENDA_TIMEZONE,
			webLink: "https://outlook.office.com/calendar/",
		};
		bucket(key).set(id, apply(base, { ...i, notesChanged: true }));
		return id;
	},
	update(key: string, id: string, i: EventInput, _scope: EventScope): string {
		const e = find(key, id);
		bucket(key).set(id, apply(e, i));
		return id;
	},
	move(key: string, id: string, allDay: boolean, start: string, end: string, tz: string = AGENDA_TIMEZONE) {
		const k = key === "own:default" ? "own:cal-main" : key;
		const e = find(k, id);
		bucket(k).set(id, { ...e, allDay, start: toParis(start, tz), end: toParis(end, tz), attendees: e.attendees.map(({ proposed: _p, ...a }) => a) });
	},
	remove(key: string, id: string) {
		find(key, id);
		bucket(key).delete(id);
		deleted.add(id);
	},
	respond(id: string, response: InviteResponse) {
		for (const b of store.values()) {
			const e = b.get(id);
			if (!e) continue;
			const status = response === "accept" ? "accepted" : response === "decline" ? "declined" : "tentativelyAccepted";
			if (response === "decline") {
				b.delete(id);
				deleted.add(id);
			} else b.set(id, { ...e, responseStatus: status, attendees: e.attendees.map((a) => (a.address === e.attendees[0]?.address ? { ...a, response: status } : a)) });
			return;
		}
		throw new AgendaError("Invitation introuvable.");
	},
	// --- Pieces jointes ---
	attachments: {
		add(id: string, f: NewAttachment) {
			const list = attachmentStore.get(id) ?? [];
			list.push({ id: `att-${++seq}`, name: f.name, contentType: f.contentType || "application/octet-stream", size: Math.floor((f.base64.length * 3) / 4), isInline: false, base64: f.base64 });
			attachmentStore.set(id, list);
		},
		remove(id: string, attId: string) {
			attachmentStore.set(id, (attachmentStore.get(id) ?? []).filter((a) => a.id !== attId));
		},
		get(id: string, attId: string): NewAttachment {
			const a = (attachmentStore.get(id) ?? []).find((x) => x.id === attId);
			if (!a) throw new AgendaError("Pièce jointe introuvable.");
			return { name: a.name, contentType: a.contentType, base64: a.base64 };
		},
	},
	// --- Categories ---
	categories: () => categories,
	createCategory(name: string, preset?: string): OutlookCategory {
		const p = preset ?? `preset${(categories.length * 3) % 25}`;
		const c = { id: `c${++seq}`, name: name.trim(), preset: p, color: categoryColor(p) };
		categories.push(c);
		return c;
	},
	// --- Salles et disponibilites ---
	rooms: () => ROOMS,
	schedules(owner: string, addresses: string[], from: string, to: string, tz: string = AGENDA_TIMEZONE): Schedule[] {
		const days = dayList(from.slice(0, 10), Math.max(1, Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000) + 1));
		return addresses.map((raw) => {
			const address = raw.toLowerCase();
			if (address.endsWith("@exemple.com")) return { address, busy: [], error: "Disponibilités non communiquées" };
			const key = address === owner ? "own:cal-main" : `colleague:${address}`;
			const busy: Schedule["busy"] = [];
			if (TEMPLATES[key]) {
				for (const e of demo.events(key, address, from.slice(0, 10), days[days.length - 1] ? addDaysSafe(days[days.length - 1], 1) : to.slice(0, 10), tz)) {
					if (!e.allDay && e.showAs !== "free") busy.push({ start: e.start, end: e.end, status: e.showAs ?? "busy" });
				}
			}
			for (const d of days) {
				for (const [wd, a, b] of BUSY[address] ?? []) {
					if (weekday(d) === wd) busy.push(fromParis({ allDay: false, start: `${d}T${a}`, end: `${d}T${b}`, status: "busy" }, tz));
				}
			}
			return { address, busy };
		});
	},
	// --- Rappels ---
	reminders(owner: string, from: string, to: string, tz: string = AGENDA_TIMEZONE): DueReminder[] {
		const out: DueReminder[] = [];
		for (const e of demo.events("own:cal-main", owner, from.slice(0, 10), addDaysSafe(to.slice(0, 10), 1), tz)) {
			if (e.allDay || e.reminderMinutes === null || e.reminderMinutes === undefined || e.start < from || e.start > to) continue;
			const st = reminderState.get(e.id);
			if (st?.dismissed) continue;
			const fire = st?.snoozedTo ?? convertZone(new Date(Date.parse(`${toParis(e.start, tz)}:00Z`) - e.reminderMinutes * 60_000).toISOString().slice(0, 16), AGENDA_TIMEZONE, tz);
			out.push({ eventId: e.id, title: e.title, start: e.start, end: e.end, location: e.location, webLink: e.webLink, joinUrl: e.joinUrl, fireAt: fire });
		}
		return out;
	},
	/** Evenements de demo a rappels multiples (liste de la propriete ss2iReminders, comme Graph). */
	reminderSources(owner: string, from: string, to: string, tz: string = AGENDA_TIMEZONE): ReminderSource[] {
		const out: ReminderSource[] = [];
		for (const e of demo.events("own:cal-main", owner, from.slice(0, 10), addDaysSafe(to.slice(0, 10), 1), tz)) {
			const offsets = reminderOffsets.get(e.id);
			if (!offsets || offsets.length < 2 || e.allDay || e.start < from || e.start > to) continue;
			out.push({ eventId: e.id, title: e.title, start: e.start, end: e.end, location: e.location, webLink: e.webLink, joinUrl: e.joinUrl, nativeMinutes: e.reminderMinutes ?? null, offsets });
		}
		return out;
	},
	dismissReminder(id: string) {
		reminderState.set(id, { dismissed: true });
	},
	snoozeReminder(id: string, at: string) {
		reminderState.set(id, { snoozedTo: at });
	},
	// --- Teams ---
	teams(id: string): TeamsOptions {
		return (
			teams.get(id) ?? {
				meetingId: id,
				lobby: "organization",
				dialInBypassLobby: false,
				presenters: "everyone",
				chat: "enabled",
				camera: true,
				mic: true,
				recordAutomatically: false,
				announceEntryExit: false,
			}
		);
	},
	setTeams(o: TeamsOptions) {
		teams.set(o.meetingId, o);
		return o;
	},
	/** Creation depuis un fil (« Ajouter a l'agenda »). */
	createSimple(owner: string, e: AgendaEvent) {
		const id = demo.create("own:cal-main", owner, {
			title: e.title,
			allDay: e.allDay,
			start: e.start,
			end: e.end,
			location: e.location,
			notes: e.notes,
			attendees: [],
			online: false,
			showAs: e.allDay ? "free" : "busy",
			isPrivate: false,
			reminderMinutes: e.reminders?.[0] ?? null,
			recurrence: "none",
		});
		if (e.reminders && e.reminders.length > 1) reminderOffsets.set(id, e.reminders);
	},
};

// --- « Ajouter a l'agenda » (thread-agenda) ---------------------------------

export function demoCreate(e: AgendaEvent): void {
	demo.createSimple(ME, e);
}

/** Proposition fictive de l'analyse du fil : relance lundi prochain a 10 h, ou la demande saisie. */
export function demoProposals(request?: string): AgendaEvent[] {
	const monday = addDays(mondayOf(todayInParis()), 7);
	if (request?.trim()) {
		return [{ title: request.trim().slice(0, 120), allDay: false, start: `${addDays(monday, 3)}T09:00`, end: `${addDays(monday, 3)}T09:15`, sourceQuote: "" }];
	}
	return [
		{ title: "Relance du client", allDay: false, start: `${monday}T10:00`, end: `${monday}T10:30`, sourceQuote: "on se recale en début de semaine prochaine" },
		{ title: "Livraison de la V2", allDay: true, start: addDays(monday, 4), end: addDays(monday, 4), sourceQuote: "livraison prévue le vendredi suivant" },
	];
}

function addDaysSafe(d: string, n: number): string {
	return addDays(d, n);
}

/**
 * Reunion Teams de demo qui commence 4 minutes apres le premier affichage du jour (heure de
 * Paris) : pour voir l'alerte de debut de reunion sans attendre.
 */
function liveMeeting(owner: string) {
	const b = bucket("own:cal-main");
	const day = todayInParis();
	const id = `own:cal-main|live|${day}`;
	if (b.has(id) || deleted.has(id)) return;
	const now = new Date();
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone: AGENDA_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
	const m = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value) + 4;
	if (m + 30 >= 24 * 60) return;
	const hh = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
	b.set(id, {
		...fromTpl("own:cal-main", owner, day, { day: 0, start: hh(m), end: hh(m + 30), title: "Point rapide (démo de l'alerte)", teams: true, attendees: ["samuel@ss2i-digital.fr"] }, 99),
		id,
	});
}
