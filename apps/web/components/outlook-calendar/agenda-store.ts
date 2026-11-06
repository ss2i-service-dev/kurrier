"use client";
// ss2i : etat de la page Agenda partage avec sa barre laterale (mini-calendrier, choix de
// l'agenda, « Nouvel evenement ») : vue, date affichee, boite, et demande d'ouverture de la
// saisie. Vue et boite sont memorisees sur le poste.
import { useSyncExternalStore } from "react";
import { type CalendarView, isCalendarView, safeTimeZone, todayInParis } from "@common/outlook-calendar";
import { AGENDA_TIMEZONE } from "@common/thread-agenda";
import type { CalendarEvent } from "@common/outlook-calendar";
import type { CalendarSource } from "@/lib/actions/outlook-calendar";

const VIEW_KEY = "ss2i.agenda.days";
const BOX_KEY = "ss2i.agenda.box";
const HIDDEN_KEY = "ss2i.agenda.hidden";
const EXTRA_KEY = "ss2i.agenda.colleagues";
const TZ_KEY = "ss2i.agenda.tz";


export type NewEventRequest = { id: number; date: string; minutes: number | null };
/** Detail d'un evenement demande hors de la grille (« A venir » de la barre laterale). */
export type DetailRequest = { id: number; event: CalendarEvent; rect: DOMRect };

type State = {
	view: CalendarView;
	anchor: string;
	boxId: string | undefined;
	newEvent: NewEventRequest | null;
	detail: DetailRequest | null;
	loaded: boolean;
	/** Agendas de la boite et des collegues (relus sur Graph par la page), et leur boite. */
	sources: CalendarSource[];
	sourcesBox?: string;
	/** Cles des agendas masques (les collegues sont masques tant qu'on ne les coche pas). */
	hidden: string[];
	shownColleagues: string[];
	/** Collegues ajoutes a la main (adresses). */
	extra: string[];
	/** Incremente a chaque ecriture : les listes d'evenements se relisent. */
	version: number;
	/** Fuseau d'affichage (IANA), Paris par defaut. */
	tz: string;
};

const initial: State = {
	view: 14,
	anchor: todayInParis(),
	boxId: undefined,
	newEvent: null,
	detail: null,
	loaded: false,
	sources: [],
	hidden: [],
	shownColleagues: [],
	extra: [],
	version: 0,
	tz: AGENDA_TIMEZONE,
};
// Rendu serveur et hydratation : toujours l'etat initial (le navigateur a peut-etre deja ses
// preferences chargees d'une visite precedente de la page).
let state: State = initial;

const readList = (k: string): string[] => {
	try {
		const v = JSON.parse(read(k) ?? "[]");
		return Array.isArray(v) ? v.map(String).slice(-300) : [];
	} catch {
		return [];
	}
};
const listeners = new Set<() => void>();

const read = (k: string) => {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
};
const write = (k: string, v: string) => {
	try {
		localStorage.setItem(k, v);
	} catch {}
};

function set(patch: Partial<State>) {
	state = { ...state, ...patch };
	for (const l of listeners) l();
}

export const agendaStore = {
	/** Preferences du poste et boites disponibles, une fois cote navigateur. */
	init(boxIds: string[]) {
		if (state.loaded) {
			if (!state.boxId || !boxIds.includes(state.boxId)) set({ boxId: boxIds[0] });
			return;
		}
		const raw = read(VIEW_KEY);
		const view = raw === "month" ? "month" : Number(raw);
		const box = read(BOX_KEY);
		const shown = readList(`${HIDDEN_KEY}.shown`);
		const tz = safeTimeZone(read(TZ_KEY) ?? AGENDA_TIMEZONE);
		set({
			tz,
			hidden: readList(HIDDEN_KEY),
			shownColleagues: shown,
			extra: readList(EXTRA_KEY),
			loaded: true,
			// date du jour lue dans le navigateur (l'etat du module serveur peut dater de son demarrage)
			anchor: todayInParis(new Date(), tz),
			view: isCalendarView(view) ? view : state.view,
			boxId: box && boxIds.includes(box) ? box : boxIds[0],
		});
	},
	setView(view: CalendarView) {
		write(VIEW_KEY, String(view));
		set({ view });
	},
	setTz(tz: string) {
		const v = safeTimeZone(tz);
		write(TZ_KEY, v);
		set({ tz: v, version: state.version + 1 });
	},
	setAnchor(anchor: string) {
		set({ anchor });
	},
	setBox(boxId: string) {
		write(BOX_KEY, boxId);
		set({ boxId });
	},
	setSources(sources: CalendarSource[], boxId?: string) {
		set({ sources, sourcesBox: boxId ?? state.sourcesBox });
	},
	/** Agendas deja charges pour cette boite (null si autre boite ou rien). */
	sourcesFor(boxId: string): CalendarSource[] | null {
		return state.sourcesBox === boxId && state.sources.length ? state.sources : null;
	},
	/** Agenda affiche ? Ceux de la boite le sont par defaut, ceux des collegues non. */
	isShown(key: string): boolean {
		return key.startsWith("colleague:") ? state.shownColleagues.includes(key) : !state.hidden.includes(key);
	},
	toggleSource(key: string) {
		if (key.startsWith("colleague:")) {
			const shownColleagues = state.shownColleagues.includes(key) ? state.shownColleagues.filter((k) => k !== key) : [...state.shownColleagues, key];
			write(`${HIDDEN_KEY}.shown`, JSON.stringify(shownColleagues));
			set({ shownColleagues });
			return;
		}
		const hidden = state.hidden.includes(key) ? state.hidden.filter((k) => k !== key) : [...state.hidden, key];
		write(HIDDEN_KEY, JSON.stringify(hidden));
		set({ hidden });
	},
	addColleague(address: string) {
		const a = address.trim().toLowerCase();
		const extra = state.extra.includes(a) ? state.extra : [...state.extra, a];
		const key = `colleague:${a}`;
		const shownColleagues = state.shownColleagues.includes(key) ? state.shownColleagues : [...state.shownColleagues, key];
		write(EXTRA_KEY, JSON.stringify(extra));
		write(`${HIDDEN_KEY}.shown`, JSON.stringify(shownColleagues));
		set({ extra, shownColleagues });
	},
	removeColleague(address: string) {
		const extra = state.extra.filter((x) => x !== address);
		const shownColleagues = state.shownColleagues.filter((k) => k !== `colleague:${address}`);
		write(EXTRA_KEY, JSON.stringify(extra));
		write(`${HIDDEN_KEY}.shown`, JSON.stringify(shownColleagues));
		set({ extra, shownColleagues, sources: state.sources.filter((s) => s.key !== `colleague:${address}`) });
	},
	/** Une ecriture a eu lieu : toutes les vues se relisent. */
	changed() {
		set({ version: state.version + 1 });
	},
	/** Ouvre la saisie d'un evenement (minutes = null : journee entiere). */
	requestNew(date: string, minutes: number | null) {
		set({ newEvent: { id: (state.newEvent?.id ?? 0) + 1, date, minutes } });
	},
	/** Ouvre la fiche d'un evenement pres de l'element clique. */
	requestDetail(event: CalendarEvent, rect: DOMRect) {
		set({ detail: { id: (state.detail?.id ?? 0) + 1, event, rect } });
	},
	consumeDetail() {
		if (state.detail) set({ detail: null });
	},
	consumeNew() {
		if (state.newEvent) set({ newEvent: null });
	},
};

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useAgendaState(): State {
	return useSyncExternalStore(subscribe, () => state, () => initial);
}
