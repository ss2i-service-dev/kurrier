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
import { type CalendarSource, type OutlookCalendarBox, type SourceRef, moveOutlookEvent, outlookCategories, outlookSources } from "@/lib/actions/outlook-calendar";
import CalendarGrid, { type MoveTarget } from "@/components/outlook-calendar/calendar-grid";
import CalendarToolbar from "@/components/outlook-calendar/calendar-toolbar";
import { useOutlookEvents } from "@/components/outlook-calendar/use-outlook-events";
import MonthGrid from "@/components/outlook-calendar/month-grid";
import { agendaStore, useAgendaState } from "@/components/outlook-calendar/agenda-store";
import EventEditor, { type EditorTarget, blankInput } from "@/components/outlook-calendar/event-editor";
import EventPopover from "@/components/outlook-calendar/event-popover";

const refOf = (s: CalendarSource): SourceRef => (s.kind === "own" ? { kind: "own", calendarId: s.calendarId } : { kind: "colleague", owner: s.owner });

export default function OutlookAgendaPage({ boxes, nouvelle }: { boxes: OutlookCalendarBox[]; nouvelle: boolean }) {
	const st = useAgendaState();
	const { view, anchor, boxId, newEvent, loaded, sources, extra, version, tz } = st;
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

	// Agendas de la boite et des collegues, relus sur Graph (droits compris).
	const extraKey = extra.join(",");
	useEffect(() => {
		if (!loaded || !boxId) return;
		let alive = true;
		outlookSources({ identityPublicId: boxId, extra })
			.catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
			.then((res) => {
				if (!alive) return;
				if (!res.ok) {
					setSourcesError(res.error);
					agendaStore.setSources([]);
					return;
				}
				setSourcesError(null);
				agendaStore.setSources(res.sources);
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
	const startForScroll = list.includes(todayInParis(new Date(), tz)) ? minutesNowInParis(new Date(), tz) : 8 * 60;
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
					onSlot={(d) => openNew(d, 9 * 60)}
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
