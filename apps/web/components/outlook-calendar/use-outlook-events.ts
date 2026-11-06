"use client";
// ss2i : evenements Outlook d'une periode pour des agendas donnes. Affichage immediat de ce
// qui est en cache (meme d'une visite precedente de la page, sessionStorage), puis relecture
// si la copie a plus de 60 s ; requetes identiques partagees (grille, barre laterale). Outlook
// reste la source : relecture toutes les 60 s quand l'onglet est visible, au retour sur
// l'onglet, et apres chaque ecriture (version de agenda-store).
import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarEvent } from "@common/outlook-calendar";
import type { SourceRef } from "@/lib/actions/outlook-calendar";
import { FRESH_MS, cachedEvents, eventsKey, invalidateEvents, loadEvents } from "@/components/outlook-calendar/agenda-api";

export function useOutlookEvents(identityPublicId: string | undefined, from: string, days: number, sources?: SourceRef[], version = 0, tz?: string) {
	const key = identityPublicId ? eventsKey(identityPublicId, from, days, sources, tz) : "";
	const [events, setEvents] = useState<CalendarEvent[]>(() => (key ? (cachedEvents(key)?.events ?? []) : []));
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
			const hit = cachedEvents(key);
			if (hit) setEvents(hit.events);
			if (hit && !force && Date.now() - hit.at < FRESH_MS) {
				setError(hit.errors?.join(" ") ?? null);
				return;
			}
			const id = ++req.current;
			setLoading(true);
			void loadEvents(identityPublicId, from, days, sourcesRef.current, tz).then((res) => {
				if (id !== req.current) return;
				setLoading(false);
				if (!res.ok) {
					setError(res.error);
					return;
				}
				setError(res.errors?.join(" ") ?? null);
				setEvents(res.events);
			});
		},
		[identityPublicId, key, from, days, tz],
	);

	useEffect(() => {
		if (!cachedEvents(key)) setEvents([]);
		load(false);
	}, [key, load]);

	// Ecriture ailleurs sur la page : relecture forcee.
	const lastVersion = useRef(version);
	useEffect(() => {
		if (version === lastVersion.current) return;
		lastVersion.current = version;
		if (identityPublicId) invalidateEvents(identityPublicId);
		load(true);
	}, [version, identityPublicId, load]);

	// Changements faits dans Outlook : relecture periodique et au retour sur l'onglet.
	useEffect(() => {
		const tick = () => document.visibilityState === "visible" && load(true);
		const t = setInterval(tick, FRESH_MS);
		const onFocus = () => {
			const hit = cachedEvents(key);
			if (!hit || Date.now() - hit.at > 15_000) load(true);
		};
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(t);
			window.removeEventListener("focus", onFocus);
		};
	}, [key, load]);

	const reload = useCallback(() => {
		if (identityPublicId) invalidateEvents(identityPublicId);
		load(true);
	}, [identityPublicId, load]);

	/** Mise a jour immediate a l'ecran (glisser-deposer) avant la reponse de Graph. */
	const patchLocal = useCallback((id: string, patch: Partial<CalendarEvent> | null) => {
		setEvents((list) => (patch ? list.map((e) => (e.id === id ? { ...e, ...patch } : e)) : list.filter((e) => e.id !== id)));
	}, []);

	return { events, loading, error, reload, patchLocal };
}
