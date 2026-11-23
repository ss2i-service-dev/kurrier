"use client";
// ss2i : lectures de l'agenda Outlook depuis le navigateur, par la route /api/outlook-calendar
// (en parallele, contrairement aux actions serveur qui passent une par une). Evenements :
// cache par boite, periode, agendas et fuseau, garde aussi dans sessionStorage (l'agenda
// s'affiche aussitot au retour sur la page, puis se met a jour) ; deux composants qui
// demandent la meme chose au meme moment partagent la meme requete.
import { addDays } from "@common/thread-agenda";
import type { CalendarEvent } from "@common/outlook-calendar";
import type { CalendarSource, SourceRef } from "@/lib/actions/outlook-calendar";

type Res<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function agendaRead<T>(op: "sources" | "events" | "reminders", payload: Record<string, unknown>): Promise<Res<T>> {
	try {
		const r = await fetch("/api/outlook-calendar", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ op, ...payload }),
			cache: "no-store",
		});
		if (r.status === 401 || r.status === 403) return { ok: false, error: "Session expirée : rechargez la page." };
		const data = (await r.json().catch(() => null)) as Res<T> | null;
		return data ?? { ok: false, error: `Agenda indisponible (HTTP ${r.status}).` };
	} catch {
		return { ok: false, error: "Agenda injoignable (réseau)." };
	}
}

// --- Evenements ------------------------------------------------------------

export type EventsEntry = { at: number; events: CalendarEvent[]; errors?: string[] };

const STORE_KEY = "ss2i.agenda.cache.v1";
// Une entree par groupe d'agendas (boite, chaque collegue) et par periode : 7 groupes sur la
// periode affichee et ses deux voisines, plus la barre laterale, depassaient les 40 d'avant.
const MAX_ENTRIES = 160;
// sessionStorage (5 Mo environ) : seules les plus recentes y sont recopiees.
const MAX_STORED = 80;
export const FRESH_MS = 60_000;

const refKey = (s: SourceRef) => (s.kind === "own" ? `own:${s.calendarId ?? "default"}` : `colleague:${s.owner}`);

export function eventsKey(identityPublicId: string, from: string, days: number, sources: SourceRef[] | undefined, tz: string | undefined) {
	const srcKey = sources ? sources.map(refKey).sort().join(",") : "default";
	return `${identityPublicId}|${from}|${addDays(from, days)}|${srcKey}|${tz ?? ""}`;
}

const cache = new Map<string, EventsEntry>();
let hydrated = false;
function hydrate() {
	if (hydrated || typeof window === "undefined") return;
	hydrated = true;
	try {
		const raw = sessionStorage.getItem(STORE_KEY);
		if (!raw) return;
		for (const [k, v] of JSON.parse(raw) as [string, EventsEntry][]) cache.set(k, { ...v, at: 0 }); // a relire, mais affichable
	} catch {}
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
	if (typeof window === "undefined") return;
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try {
			const entries = [...cache.entries()].slice(-MAX_STORED);
			sessionStorage.setItem(STORE_KEY, JSON.stringify(entries));
		} catch {}
	}, 300);
}

export function cachedEvents(key: string): EventsEntry | undefined {
	hydrate();
	return cache.get(key);
}

/** Toutes les entrees d'une boite deviennent a relire (ecriture faite). */
export function invalidateEvents(identityPublicId: string) {
	hydrate();
	for (const [k, v] of cache) if (k.startsWith(`${identityPublicId}|`)) cache.set(k, { ...v, at: 0 });
}

const inflight = new Map<string, Promise<Res<{ events: CalendarEvent[]; errors?: string[] }>>>();

/** Lit (ou partage la lecture en cours) et range le resultat dans le cache. */
export function loadEvents(
	identityPublicId: string,
	from: string,
	days: number,
	sources: SourceRef[] | undefined,
	tz: string | undefined,
): Promise<Res<{ events: CalendarEvent[]; errors?: string[] }>> {
	hydrate();
	const key = eventsKey(identityPublicId, from, days, sources, tz);
	const running = inflight.get(key);
	if (running) return running;
	const p = agendaRead<{ events: CalendarEvent[]; errors?: string[] }>("events", { identityPublicId, from, to: addDays(from, days), sources, tz }).then((res) => {
		inflight.delete(key);
		if (res.ok) {
			cache.delete(key);
			cache.set(key, { at: Date.now(), events: res.events, errors: res.errors });
			while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
			persist();
		}
		return res;
	});
	inflight.set(key, p);
	return p;
}

/**
 * Lectures separees : les agendas de la boite ensemble, chaque collegue a part. Un collegue
 * lent (droits de partage relus sur Graph, jusqu'a 20 s a froid le 23/11) ne retient plus
 * les evenements de la boite ni ceux des autres collegues.
 */
export function sourceGroups(sources: SourceRef[] | undefined): (SourceRef[] | undefined)[] {
	if (!sources) return [undefined];
	const own = sources.filter((s) => s.kind === "own");
	const colleagues = sources.filter((s) => s.kind !== "own");
	return [...(own.length ? [own] : []), ...colleagues.map((c) => [c])];
}

/** Periode voisine lue d'avance (fleches instantanees), sans rien afficher. */
export function prefetchEvents(identityPublicId: string, from: string, days: number, sources: SourceRef[] | undefined, tz: string | undefined) {
	for (const group of sourceGroups(sources)) {
		const hit = cachedEvents(eventsKey(identityPublicId, from, days, group, tz));
		if (hit && Date.now() - hit.at < FRESH_MS) continue;
		void loadEvents(identityPublicId, from, days, group, tz);
	}
}

// --- Agendas (sources) -------------------------------------------------------

const sourcesKey = (identityPublicId: string) => `ss2i.agenda.sources.${identityPublicId}`;

/** Derniers agendas connus de la boite (affichage immediat avant la relecture Graph). */
export function cachedSources(identityPublicId: string): CalendarSource[] | null {
	try {
		const raw = localStorage.getItem(sourcesKey(identityPublicId));
		const v = raw ? JSON.parse(raw) : null;
		return Array.isArray(v) ? (v as CalendarSource[]) : null;
	} catch {
		return null;
	}
}

export function storeSources(identityPublicId: string, sources: CalendarSource[]) {
	try {
		localStorage.setItem(sourcesKey(identityPublicId), JSON.stringify(sources));
	} catch {}
}
