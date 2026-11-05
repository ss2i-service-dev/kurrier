"use client";
// ss2i : agenda Outlook a cote des propositions de « Ajouter a l'agenda » (Hugo, 05/11 : « on
// est vendredi et il faut pouvoir planifier sur la semaine d'apres »). Deux semaines a partir
// du lundi de la proposition en cours (ou d'aujourd'hui), fleches pour avancer. Les
// propositions cochees sont dessinees en pointilles au milieu des rendez-vous existants, celle
// en cours d'edition en plein ; un clic sur un creneau y deplace la proposition en cours
// (meme duree), un clic dans la ligne « Jour » en fait une journee entiere ce jour-la.
import React, { useEffect, useMemo, useState } from "react";
import { addDays } from "@common/thread-agenda";
import { type CalendarEvent, dayList, minutesOf, navigationStep, rangeLabel, rangeStart, todayInParis } from "@common/outlook-calendar";
import CalendarGrid from "@/components/outlook-calendar/calendar-grid";
import CalendarToolbar from "@/components/outlook-calendar/calendar-toolbar";
import { useOutlookEvents } from "@/components/outlook-calendar/use-outlook-events";

export type PlanningProposal = { key: number; title: string; allDay: boolean; start: string; end: string; checked: boolean };

const DAYS = 14;

export default function PlanningPanel({
	identityPublicId,
	proposals,
	activeKey,
	nouvelle,
	onPlace,
	onActivate,
}: {
	identityPublicId: string;
	proposals: PlanningProposal[];
	activeKey: number | null;
	nouvelle: boolean;
	/** Proposition en cours placee sur ce jour (minutes = null : journee entiere). */
	onPlace: (key: number, date: string, minutes: number | null) => void;
	onActivate: (key: number) => void;
}) {
	const active = proposals.find((p) => p.key === activeKey && p.checked) ?? null;
	const activeDay = active?.start.slice(0, 10) ?? null;
	const [anchor, setAnchor] = useState(() => (activeDay && activeDay >= todayInParis() ? activeDay : todayInParis()));
	const start = rangeStart(anchor, DAYS);
	const days = useMemo(() => dayList(start, DAYS), [start]);

	// La proposition en cours sort de la periode (date saisie a la main) : la periode la suit.
	useEffect(() => {
		if (activeDay && !days.includes(activeDay)) setAnchor(activeDay);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeDay]);

	const { events, loading, error, reload } = useOutlookEvents(identityPublicId, start, DAYS);

	const shown: CalendarEvent[] = useMemo(
		() => [
			...events,
			...proposals
				// Proposition en cours de saisie (date ou heure incomplete) : pas dessinee.
				.filter((p) => p.checked && (p.allDay ? p.start.length >= 10 : p.start.length >= 16 && (p.end || p.start).length >= 16))
				.map((p) => ({
					id: `proposal-${p.key}`,
					title: p.title || "(Sans titre)",
					allDay: p.allDay,
					start: p.start,
					end: p.end || p.start,
					ghost: true,
					active: p.key === activeKey,
				})),
		],
		[events, proposals, activeKey],
	);

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";

	return (
		<div className={`flex h-full min-h-0 flex-col rounded-md border ${nouvelle ? "border-k-line" : ""}`}>
			<div className={`space-y-1 border-b px-2 py-1.5 ${nouvelle ? "border-k-line" : ""}`}>
				<CalendarToolbar
					nouvelle={nouvelle}
					label={rangeLabel(start, DAYS)}
					onPrev={() => setAnchor(addDays(start, -navigationStep(DAYS)))}
					onNext={() => setAnchor(addDays(start, navigationStep(DAYS)))}
					onToday={() => setAnchor(todayInParis())}
					onReload={reload}
					loading={loading}
				/>
				<div className={`text-[11.5px] ${muted}`}>
					{active
						? `Cliquez sur un créneau pour y placer « ${active.title || "l'événement"} ».`
						: "Cochez une proposition pour la placer sur l'agenda."}
				</div>
				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800" role="alert">
						{error}
					</div>
				)}
			</div>
			<CalendarGrid
				className="flex-1"
				days={days}
				events={shown}
				nouvelle={nouvelle}
				hourHeight={36}
				loading={loading}
				scrollTo={active && !active.allDay && active.start.length >= 16 ? minutesOf(active.start) : 8 * 60}
				onSlot={active ? (d, m) => onPlace(active.key, d, m) : undefined}
				onAllDaySlot={active ? (d) => onPlace(active.key, d, null) : undefined}
				onEventClick={(e) => {
					if (e.ghost) onActivate(Number(e.id.slice("proposal-".length)));
				}}
			/>
		</div>
	);
}
