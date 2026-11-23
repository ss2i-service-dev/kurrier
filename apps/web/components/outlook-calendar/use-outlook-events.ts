"use client";
// ss2i : evenements Outlook d'une periode pour des agendas donnes. Affichage immediat de ce
// qui est en cache (meme d'une visite precedente de la page, sessionStorage), puis relecture
// si la copie a plus de 60 s ; requetes identiques partagees (grille, barre laterale). Outlook
// reste la source : relecture toutes les 60 s quand l'onglet est visible, au retour sur
// l'onglet, et apres chaque ecriture (version de agenda-store).
//
// Une lecture par groupe (sourceGroups : agendas de la boite ensemble, chaque collegue a part),
// affichee des qu'elle arrive : un collegue lent ne retient plus le reste de la grille
// (23/11/2026, droits de partage relus jusqu'a 20 s a froid).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent } from "@common/outlook-calendar";
import type { SourceRef } from "@/lib/actions/outlook-calendar";
import { FRESH_MS, cachedEvents, eventsKey, invalidateEvents, loadEvents, sourceGroups } from "@/components/outlook-calendar/agenda-api";

export function useOutlookEvents(identityPublicId: string | undefined, from: string, days: number, sources?: SourceRef[], version = 0, tz?: string) {
	const key = identityPublicId ? eventsKey(identityPublicId, from, days, sources, tz) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: la cle resume les sources
	const groups = useMemo(() => sourceGroups(sources), [key]);
	const groupKeys = useMemo(
		() => (identityPublicId ? groups.map((g) => eventsKey(identityPublicId, from, days, g, tz)) : []),
		[identityPublicId, groups, from, days, tz],
	);
	const fromCache = (keys: string[]) => keys.flatMap((k) => cachedEvents(k)?.events ?? []);
	const allCached = (keys: string[]) => keys.length > 0 && keys.every((k) => !!cachedEvents(k));

	const [events, setEvents] = useState<CalendarEvent[]>(() => fromCache(groupKeys));
	const [loading, setLoading] = useState(false);
	// Une lecture (ou une copie en cache) est arrivee pour cette periode : avant, « aucun evenement » ne veut rien dire.
	const [loaded, setLoaded] = useState(() => allCached(groupKeys));
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
			const id = ++req.current;
			const errors: (string | null)[] = groups.map(() => null);
			const showErrors = () => {
				const list = errors.filter((e): e is string => !!e);
				setError(list.length ? list.join(" ") : null);
			};
			setEvents(fromCache(groupKeys));
			let pending = 0;
			groups.forEach((group, i) => {
				const hit = cachedEvents(groupKeys[i]);
				if (hit && !force && Date.now() - hit.at < FRESH_MS) {
					errors[i] = hit.errors?.join(" ") ?? null;
					return;
				}
				pending++;
				void loadEvents(identityPublicId, from, days, group, tz).then((res) => {
					if (id !== req.current) return;
					pending--;
					errors[i] = res.ok ? (res.errors?.join(" ") ?? null) : res.error;
					// Groupe en echec : sa derniere copie connue reste affichee.
					setEvents(fromCache(groupKeys));
					showErrors();
					if (!pending) {
						setLoading(false);
						setLoaded(true);
					}
				});
			});
			showErrors();
			if (pending) setLoading(true);
			else {
				setLoading(false);
				setLoaded(true);
			}
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: fromCache ne lit que le cache
		[identityPublicId, groups, groupKeys, from, days, tz],
	);

	useEffect(() => {
		if (!allCached(groupKeys)) {
			setEvents(fromCache(groupKeys));
			setLoaded(false);
		}
		load(false);
		// biome-ignore lint/correctness/useExhaustiveDependencies: relu a chaque changement de periode ou d'agendas
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
			const stale = groupKeys.some((k) => {
				const hit = cachedEvents(k);
				return !hit || Date.now() - hit.at > 15_000;
			});
			if (stale) load(true);
		};
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(t);
			window.removeEventListener("focus", onFocus);
		};
	}, [groupKeys, load]);

	const reload = useCallback(() => {
		if (identityPublicId) invalidateEvents(identityPublicId);
		load(true);
	}, [identityPublicId, load]);

	/** Mise a jour immediate a l'ecran (glisser-deposer) avant la reponse de Graph. */
	const patchLocal = useCallback((id: string, patch: Partial<CalendarEvent> | null) => {
		setEvents((list) => (patch ? list.map((e) => (e.id === id ? { ...e, ...patch } : e)) : list.filter((e) => e.id !== id)));
	}, []);

	return { events, loading, loaded, error, reload, patchLocal };
}
