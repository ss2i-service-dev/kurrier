"use client";
// ss2i : evenements Outlook d'une periode pour des agendas donnes. Cache par boite, periode
// et agendas le temps de la page (les fleches qui reviennent en arriere ne relisent pas
// Graph). Outlook reste la source : relecture toutes les 60 s quand l'onglet est visible, au
// retour sur l'onglet, et apres chaque ecriture (version de agenda-store).
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays } from "@common/thread-agenda";
import type { CalendarEvent } from "@common/outlook-calendar";
import { type SourceRef, fetchOutlookEvents } from "@/lib/actions/outlook-calendar";

const cache = new Map<string, { at: number; events: CalendarEvent[]; errors?: string[] }>();
const FRESH_MS = 60_000;

const refKey = (s: SourceRef) => (s.kind === "own" ? `own:${s.calendarId ?? "default"}` : `colleague:${s.owner}`);

export function useOutlookEvents(identityPublicId: string | undefined, from: string, days: number, sources?: SourceRef[], version = 0, tz?: string) {
	const to = addDays(from, days);
	const srcKey = sources ? sources.map(refKey).sort().join(",") : "default";
	const key = identityPublicId ? `${identityPublicId}|${from}|${to}|${srcKey}|${tz ?? ""}` : "";
	const [events, setEvents] = useState<CalendarEvent[]>(() => cache.get(key)?.events ?? []);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const req = useRef(0);
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;

	const load = useCallback(
		(force: boolean) => {
			if (!identityPublicId) return;
			if (sourcesRef.current && !sourcesRef.current.length) {
				setEvents([]);
				setError(null);
				return;
			}
			const hit = cache.get(key);
			if (hit) setEvents(hit.events);
			if (hit && !force && Date.now() - hit.at < FRESH_MS) {
				setError(hit.errors?.join(" ") ?? null);
				return;
			}
			const id = ++req.current;
			setLoading(true);
			fetchOutlookEvents({ identityPublicId, from, to, sources: sourcesRef.current, tz })
				.catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
				.then((res) => {
					if (id !== req.current) return;
					setLoading(false);
					if (!res.ok) {
						setError(res.error);
						return;
					}
					setError(res.errors?.join(" ") ?? null);
					cache.set(key, { at: Date.now(), events: res.events, errors: res.errors });
					setEvents(res.events);
				});
		},
		[identityPublicId, key, from, to, tz],
	);

	useEffect(() => {
		if (!cache.has(key)) setEvents([]);
		load(false);
	}, [key, load]);

	// Ecriture ailleurs sur la page : relecture forcee.
	const lastVersion = useRef(version);
	useEffect(() => {
		if (version === lastVersion.current) return;
		lastVersion.current = version;
		for (const k of cache.keys()) if (k.startsWith(`${identityPublicId}|`)) cache.delete(k);
		load(true);
	}, [version, identityPublicId, load]);

	// Changements faits dans Outlook : relecture periodique et au retour sur l'onglet.
	useEffect(() => {
		const tick = () => document.visibilityState === "visible" && load(true);
		const t = setInterval(tick, FRESH_MS);
		const onFocus = () => {
			const hit = cache.get(key);
			if (!hit || Date.now() - hit.at > 15_000) load(true);
		};
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(t);
			window.removeEventListener("focus", onFocus);
		};
	}, [key, load]);

	const reload = useCallback(() => {
		for (const k of cache.keys()) if (k.startsWith(`${identityPublicId}|`)) cache.delete(k);
		load(true);
	}, [identityPublicId, load]);

	/** Mise a jour immediate a l'ecran (glisser-deposer) avant la reponse de Graph. */
	const patchLocal = useCallback((id: string, patch: Partial<CalendarEvent> | null) => {
		setEvents((list) => (patch ? list.map((e) => (e.id === id ? { ...e, ...patch } : e)) : list.filter((e) => e.id !== id)));
	}, []);

	return { events, loading, error, reload, patchLocal };
}
