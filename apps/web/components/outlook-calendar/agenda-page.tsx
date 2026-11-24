"use client";
// ss2i : page Agenda, l'agenda Outlook de l'utilisateur dans courrier, facon Notion Calendar,
// en remplacement d'Outlook : tout est lu et ecrit par Microsoft Graph, Outlook voit tout
// aussitot (et ce qui change dans Outlook revient ici en moins d'une minute).
// Deux semaines a partir du lundi par defaut (un vendredi, on voit la semaine suivante), 1, 3
// ou 7 jours, ou le mois (memorise sur le poste, partage avec la barre laterale par
// agenda-store). Agendas de la boite et de collegues affiches ou masques depuis la barre
// laterale, chacun a sa couleur. Clic ou trace sur un creneau : nouvel evenement ; glisser un
// evenement : deplacement, sa poignee : duree ; clic : detail (repondre, modifier, supprimer).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { NativeSelect } from "@mantine/core";
import { toast } from "sonner";
import {
	type CalendarEvent,
	minutesNowInParis,
	monthStart,
	stepView,
	todayInParis,
	viewDays,
	viewLabel,
} from "@common/outlook-calendar";
import type { OutlookCategory } from "@common/outlook-graph";
import { type CalendarSource, type OutlookCalendarBox, type SourceRef, moveOutlookEvent, outlookCategories } from "@/lib/actions/outlook-calendar";
import { agendaRead, cachedSources, prefetchEvents, storeSources } from "@/components/outlook-calendar/agenda-api";
import CalendarGrid, { type MoveTarget } from "@/components/outlook-calendar/calendar-grid";
import CalendarToolbar from "@/components/outlook-calendar/calendar-toolbar";
import { useOutlookEvents } from "@/components/outlook-calendar/use-outlook-events";
import MonthGrid from "@/components/outlook-calendar/month-grid";
import { agendaStore, useAgendaState } from "@/components/outlook-calendar/agenda-store";
import EventEditor, { type EditorTarget, blankInput } from "@/components/outlook-calendar/event-editor";
import EventPopover from "@/components/outlook-calendar/event-popover";
import { purgeFormBackups, recentFormBackup } from "@/lib/form-backup";
import { zoomStep } from "@/lib/agenda-zoom";
import { agendaDateParam } from "@/lib/invite-preview";

// Reouverture de l'editeur apres un rechargement : une fois par chargement de la page web (pas a
// chaque retour sur l'Agenda dans la meme session).
let reopenChecked = false;

const refOf = (s: CalendarSource): SourceRef => (s.kind === "own" ? { kind: "own", calendarId: s.calendarId } : { kind: "colleague", owner: s.owner });

export default function OutlookAgendaPage({ boxes, nouvelle }: { boxes: OutlookCalendarBox[]; nouvelle: boolean }) {
	const st = useAgendaState();
	const { view, anchor, boxId, newEvent, loaded, extra, version, tz, hourHeight, workStart, workEnd } = st;
	// Agendas d'une autre boite (changement de boite) : pas melanges a celle-ci.
	const sources = st.sourcesBox === boxId ? st.sources : [];
	const [categories, setCategories] = useState<OutlookCategory[]>([]);
	const [sourcesError, setSourcesError] = useState<string | null>(null);
	const [editor, setEditor] = useState<EditorTarget | null>(null);
	const [detail, setDetail] = useState<{ event: CalendarEvent; rect: DOMRect } | null>(null);
	// Creneaux proposes montres en pointilles pendant que la fiche est ouverte.
	const [preview, setPreview] = useState<{ start: string; end: string; label: string }[] | null>(null);
	const position = nouvelle ? "bottom-center" : "bottom-left";

	// Preferences du poste, lues apres le premier rendu (pas d'ecart serveur / client).
	useEffect(() => {
		agendaStore.init(boxes.map((b) => b.identityPublicId));
	}, [boxes]);

	// Ouverture sur un jour donne (?date=YYYY-MM-DD, et ?box=<identite> : lien « Ouvrir dans
	// l'agenda » de l'encart d'une invitation). Seule la date affichee change : la vue (1, 3, 7,
	// 14 jours, mois) memorisee sur le poste reste celle de l'utilisateur. Apres init, qui pose
	// aujourd'hui.
	const search = useSearchParams();
	const wantedDate = agendaDateParam(search?.toString() ?? "");
	const wantedBox = search?.get("box") ?? null;
	useEffect(() => {
		if (!wantedDate) return;
		if (wantedBox && boxes.some((b) => b.identityPublicId === wantedBox)) agendaStore.setBox(wantedBox);
		agendaStore.setAnchor(wantedDate);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wantedDate, wantedBox]);

	// Copie locale d'un evenement en cours de saisie (lib/form-backup.ts) : les copies de plus de
	// 7 jours sont purgees ; apres un rechargement (deploiement, F5, plantage) une copie de moins
	// de 24 h rouvre l'editeur pre-rempli, une seule fois. Editeur deja ouvert entre-temps : un
	// toast propose de reprendre. La boite de la copie est reprise si ce n'est pas celle affichee.
	useEffect(() => {
		purgeFormBackups();
	}, []);
	const hasSources = sources.length > 0;
	useEffect(() => {
		if (reopenChecked || !loaded || !boxId) return;
		const b = recentFormBackup(["agenda:new:", "agenda:edit:"]);
		const saved = b?.values as { target?: EditorTarget; identityPublicId?: string } | undefined;
		const target = saved?.target;
		const identity = saved?.identityPublicId;
		if (!target?.initial || !identity || !boxes.some((x) => x.identityPublicId === identity)) {
			reopenChecked = true;
			return;
		}
		if (identity !== boxId) {
			agendaStore.setBox(identity);
			return;
		}
		if (!hasSources) return;
		reopenChecked = true;
		if (!editor) {
			setEditor(target);
			return;
		}
		toast("Un événement en cours de saisie a été conservé", {
			id: "form-backup:agenda",
			position,
			duration: Number.POSITIVE_INFINITY,
			action: { label: "Reprendre", onClick: () => setEditor(target) },
		});
	}, [loaded, boxId, boxes, hasSources, editor, position]);

	// Agendas de la boite et des collegues, relus sur Graph (droits compris). Affichage immediat
	// des derniers connus ; puis, en parallele, les agendas de la boite (rapides : la grille part
	// aussitot) et ceux des collegues (droits de partage, lents).
	const extraKey = extra.join(",");
	useEffect(() => {
		if (!loaded || !boxId) return;
		let alive = true;
		const known = cachedSources(boxId);
		if (known?.length && !agendaStore.sourcesFor(boxId)) agendaStore.setSources(known, boxId);
		let own: CalendarSource[] | null = null;
		let colleagues: CalendarSource[] | null = null;
		const publish = () => {
			if (!alive || !own) return;
			// Collegues pas encore relus : ceux deja connus restent affiches.
			const others = colleagues ?? (known ?? []).filter((s) => s.kind === "colleague");
			const all = [...own, ...others];
			agendaStore.setSources(all, boxId);
			if (colleagues) storeSources(boxId, all);
		};
		const fail = (e: string) => {
			if (!alive) return;
			setSourcesError(e);
			if (!known?.length) agendaStore.setSources([], boxId);
		};
		void agendaRead<{ sources: CalendarSource[] }>("sources", { identityPublicId: boxId, colleagues: false }).then((res) => {
			if (!res.ok) return fail(res.error);
			setSourcesError(null);
			own = res.sources;
			publish();
		});
		void agendaRead<{ sources: CalendarSource[] }>("sources", { identityPublicId: boxId, extra, colleaguesOnly: true }).then((res) => {
			colleagues = res.ok ? res.sources : [];
			publish();
		});
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loaded, boxId, extraKey]);

	// Categories Outlook de la boite (couleurs des evenements, choix dans le formulaire).
	useEffect(() => {
		if (!loaded || !boxId) return;
		let alive = true;
		outlookCategories({ identityPublicId: boxId })
			.then((res) => alive && setCategories(res.ok ? res.categories : []))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [loaded, boxId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: isShown lit hidden et shownColleagues
	const visible = useMemo(() => sources.filter((s) => agendaStore.isShown(s.key)), [sources, st.hidden, st.shownColleagues]);
	const refs = useMemo(() => visible.map(refOf), [visible]);
	const list = useMemo(() => viewDays(view, anchor), [view, anchor]);
	const { events: raw, loading, error, reload, patchLocal } = useOutlookEvents(loaded && sources.length ? boxId : undefined, list[0], list.length, refs, version, tz);
	const byKey = useMemo(() => new Map(sources.map((s) => [s.key, s])), [sources]);

	// Periodes precedente et suivante lues d'avance : les fleches sont instantanees.
	useEffect(() => {
		if (loading || !boxId || !refs.length) return;
		const t = setTimeout(() => {
			for (const dir of [1, -1] as const) {
				const days = viewDays(view, stepView(view, anchor, dir));
				prefetchEvents(boxId, days[0], days.length, refs, tz);
			}
		}, 1500);
		return () => clearTimeout(t);
	}, [loading, boxId, refs, view, anchor, tz]);
	const catColor = useMemo(() => new Map(categories.map((c) => [c.name, c.color])), [categories]);
	// Comme Outlook : un evenement de mes agendas prend la couleur de sa premiere categorie.
	const events = useMemo(
		() =>
			raw.map((e) => {
				const cat = e.sourceKey?.startsWith("own:") ? e.categories?.map((c) => catColor.get(c)).find(Boolean) : undefined;
				return { ...e, color: cat ?? byKey.get(e.sourceKey ?? "")?.color };
			}),
		[raw, byKey, catColor],
	);
	const shownEvents = useMemo(
		() =>
			preview?.length
				? [
						...events,
						...preview.map((p, i) => ({ id: `preview-${i}`, title: p.label, allDay: false, start: p.start, end: p.end, ghost: true }) as CalendarEvent),
					]
				: events,
		[events, preview],
	);
	const box = boxes.find((b) => b.identityPublicId === boxId);
	const defaultSource = sources.find((s) => s.isDefault) ?? sources.find((s) => s.kind === "own");

	const openNew = useCallback(
		(date: string, minutes: number | null, endMinutes?: number) => {
			if (!defaultSource) return;
			setDetail(null);
			setEditor({ source: refOf(defaultSource), sourceKey: defaultSource.key, initial: blankInput(date, minutes, endMinutes) });
		},
		[defaultSource],
	);

	// Fiche demandee depuis « A venir » de la barre laterale.
	useEffect(() => {
		if (!st.detail) return;
		setEditor(null);
		setDetail({ event: st.detail.event, rect: st.detail.rect });
		agendaStore.consumeDetail();
	}, [st.detail]);

	// « Nouvel evenement » de la barre laterale.
	useEffect(() => {
		if (!newEvent || !defaultSource) return;
		openNew(newEvent.date, newEvent.minutes);
		agendaStore.consumeNew();
	}, [newEvent, defaultSource, openNew]);

	const saved = (message: string) => {
		toast.success(message, { position });
		setEditor(null);
		setDetail(null);
		agendaStore.changed();
	};

	// Glisser-deposer : a l'ecran tout de suite, ecrit dans Outlook, annule si Graph refuse.
	const move = async (e: CalendarEvent, to: MoveTarget) => {
		const src = byKey.get(e.sourceKey ?? "");
		if (!src || !boxId) return;
		const before = { start: e.start, end: e.end, allDay: e.allDay };
		patchLocal(e.id, to);
		const res = await moveOutlookEvent({ identityPublicId: boxId, source: refOf(src), id: e.id, ...to, tz }).catch((err: unknown) => ({
			ok: false as const,
			error: String((err as Error)?.message ?? err),
		}));
		if (!res.ok) {
			patchLocal(e.id, before);
			toast.error(res.error, { position });
			return;
		}
		toast.success(e.recurring ? "Occurrence déplacée" : "Événement déplacé", { position });
		agendaStore.changed();
	};

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";

	if (!boxes.length) {
		return (
			<div className={`p-8 text-sm ${muted}`}>
				Aucun agenda Outlook accessible : aucune de vos adresses n'est une boîte Microsoft 365 du tenant (BRIDGE_MAILBOXES), ou l'agenda
				n'est pas configuré sur le serveur.
			</div>
		);
	}
	if (!loaded || !boxId) return <div className="flex min-h-0 flex-1 flex-col" />;

	// Periode qui contient aujourd'hui : l'heure actuelle au tiers haut ; sinon 8 h.
	const startForScroll = list.includes(todayInParis(new Date(), tz)) ? minutesNowInParis(new Date(), tz) : workStart;
	const zoomIn = zoomStep(hourHeight, 1) !== hourHeight ? () => agendaStore.setHourHeight(zoomStep(hourHeight, 1)) : null;
	const zoomOut = zoomStep(hourHeight, -1) !== hourHeight ? () => agendaStore.setHourHeight(zoomStep(hourHeight, -1)) : null;
	const shownError = sourcesError ?? error;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className={`border-b px-4 py-2.5 ${nouvelle ? "border-k-line" : ""}`}>
				<CalendarToolbar
					nouvelle={nouvelle}
					label={viewLabel(view, anchor)}
					view={view}
					onPrev={() => agendaStore.setAnchor(stepView(view, anchor, -1))}
					onNext={() => agendaStore.setAnchor(stepView(view, anchor, 1))}
					onToday={() => agendaStore.setAnchor(todayInParis(new Date(), tz))}
					onView={(v) => agendaStore.setView(v)}
					onReload={reload}
					loading={loading}
					onZoomIn={view === "month" ? undefined : zoomIn}
					onZoomOut={view === "month" ? undefined : zoomOut}
					extra={
						boxes.length > 1 ? (
							<NativeSelect
								size="xs"
								aria-label="Boîte"
								value={boxId}
								onChange={(e) => agendaStore.setBox(e.currentTarget.value)}
								data={boxes.map((b) => ({ value: b.identityPublicId, label: b.address }))}
							/>
						) : (
							<span className={`hidden text-[12px] lg:inline ${muted}`}>Outlook · {box?.address}</span>
						)
					}
				/>
				{/* Lecture en cours : barre fine (et message tant que rien n'est encore affiche). */}
				{(loading || !sources.length) && !shownError && (
					<div className="relative mt-2 h-0.5 overflow-hidden rounded bg-black/5 dark:bg-white/10" aria-hidden>
						<div className={`absolute inset-y-0 w-1/3 animate-[k-agenda-load_1.1s_ease-in-out_infinite] rounded ${nouvelle ? "bg-k-accent" : "bg-primary"}`} />
						<style>{"@keyframes k-agenda-load{0%{left:-33%}100%{left:100%}}"}</style>
					</div>
				)}
				{!raw.length && (loading || !sources.length) && !shownError && (
					<div className={`mt-1.5 text-[12px] ${muted}`}>Lecture de l'agenda Outlook…</div>
				)}
				{shownError && (
					<div className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800" role="alert">
						{shownError}
					</div>
				)}
			</div>

			{view === "month" ? (
				<MonthGrid
					className="flex-1"
					days={list}
					month={monthStart(anchor)}
					events={shownEvents}
					nouvelle={nouvelle}
					onDay={(d) => {
						agendaStore.setAnchor(d);
						agendaStore.setView(1);
					}}
					onSlot={(d) => openNew(d, workStart)}
					onMove={(e, to) => void move(e, to)}
					tz={tz}
					onEventClick={(event, rect) => {
						if (event.ghost) return;
						setEditor(null);
						setDetail({ event, rect });
					}}
				/>
			) : (
				<CalendarGrid
					className="flex-1"
					days={list}
					events={shownEvents}
					nouvelle={nouvelle}
					loading={loading}
					scrollTo={startForScroll}
					scrollKey={`${view}|${list[0]}|${tz}`}
					tz={tz}
					hourHeight={hourHeight}
					onZoom={(h) => agendaStore.setHourHeight(h)}
					workStart={workStart}
					workEnd={workEnd}
					onSlot={(d, m) => openNew(d, m)}
					onRange={(d, a, b) => openNew(d, a, b)}
					onAllDaySlot={(d) => openNew(d, null)}
					onMove={(e, to) => void move(e, to)}
					onEventClick={(event, rect) => {
						if (event.ghost) return;
						setEditor(null);
						setDetail({ event, rect });
					}}
				/>
			)}

			{detail && (
				<EventPopover
					key={detail.event.id}
					event={detail.event}
					rect={detail.rect}
					source={byKey.get(detail.event.sourceKey ?? "")}
					identityPublicId={boxId}
					nouvelle={nouvelle}
					tz={tz}
					categories={categories}
					onClose={() => setDetail(null)}
					onPreview={setPreview}
					onEdit={(t) => {
						setDetail(null);
						setEditor(t);
					}}
					onChanged={saved}
				/>
			)}

			<EventEditor
				target={editor}
				identityPublicId={boxId}
				sources={sources}
				nouvelle={nouvelle}
				tz={tz}
				categories={categories}
				onCategoryCreated={(c) => setCategories((list) => [...list, c])}
				onClose={() => setEditor(null)}
				onSaved={saved}
			/>
		</div>
	);
}
