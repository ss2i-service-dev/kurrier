"use client";
// ss2i : vue mois de l'agenda Outlook. Une ligne par semaine (lundi -> dimanche), les jours
// hors du mois attenues. Chaque case montre ses evenements (journees entieres d'abord) puis
// « +N autres » ; un clic sur le numero du jour ouvre ce jour, un clic dans la case ouvre la
// saisie d'un evenement ce jour-la, un clic sur un evenement son detail. Un evenement
// modifiable se glisse sur un autre jour (memes heures, meme duree).
import React, { useState } from "react";
import { type CalendarEvent, JOURS_COURTS, eventsOfDay, shiftToDay, todayInParis, weekday } from "@common/outlook-calendar";
import { MeetingBadge, type MoveTarget } from "@/components/outlook-calendar/calendar-grid";

const MAX_PER_DAY = 4;
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function MonthGrid({
	days,
	month,
	events,
	nouvelle,
	onDay,
	onSlot,
	onEventClick,
	onMove,
	tz,
	className = "",
}: {
	days: string[];
	/** Mois affiche, YYYY-MM-01. */
	month: string;
	events: CalendarEvent[];
	nouvelle: boolean;
	onDay: (date: string) => void;
	onSlot: (date: string) => void;
	onEventClick: (event: CalendarEvent, anchor: DOMRect) => void;
	onMove?: (event: CalendarEvent, to: MoveTarget) => void;
	tz?: string;
	className?: string;
}) {
	const today = todayInParis(new Date(), tz);
	const [dragged, setDragged] = useState<CalendarEvent | null>(null);
	const [over, setOver] = useState<string | null>(null);
	const dropRing = nouvelle ? "ring-2 ring-inset ring-k-accent" : "ring-2 ring-inset ring-primary";
	const weeks: string[][] = [];
	for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

	const line = nouvelle ? "border-k-line" : "border-border";
	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const hover = nouvelle ? "hover:bg-k-hover/60" : "hover:bg-muted/40";
	const weekend = nouvelle ? "bg-k-surface-2" : "bg-muted/30";
	const todayBadge = nouvelle ? "bg-k-accent text-white" : "bg-primary text-primary-foreground";
	const chip = nouvelle ? "bg-k-accent-soft text-k-accent-soft-ink" : "bg-primary/15 text-foreground";
	const dot = nouvelle ? "bg-k-accent" : "bg-primary";

	return (
		<div className={`flex min-h-0 flex-col text-[12px] ${className}`}>
			<div className={`grid grid-cols-7 border-b ${line}`}>
				{ORDER.map((d) => (
					<div key={d} className={`px-2 py-1.5 text-[11px] uppercase tracking-wide ${muted}`}>
						{JOURS_COURTS[d]}
					</div>
				))}
			</div>
			<div className="grid min-h-0 flex-1" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
				{weeks.map((week) => (
					<div key={week[0]} className={`grid min-h-0 grid-cols-7 border-b ${line}`}>
						{week.map((d) => {
							const inMonth = d.slice(0, 7) === month.slice(0, 7);
							const wk = weekday(d) === 0 || weekday(d) === 6;
							const list = eventsOfDay(events, d);
							const shown = list.slice(0, list.length > MAX_PER_DAY ? MAX_PER_DAY - 1 : MAX_PER_DAY);
							const more = list.length - shown.length;
							return (
								<div
									key={d}
									className={`flex min-h-0 min-w-0 cursor-pointer flex-col gap-px overflow-hidden border-l p-1 first:border-l-0 ${line} ${wk ? weekend : ""} ${hover} ${
										inMonth ? "" : "opacity-50"
									} ${over === d ? dropRing : ""}`}
									onClick={() => onSlot(d)}
									onDragOver={(ev) => {
										if (!dragged) return;
										ev.preventDefault();
										ev.dataTransfer.dropEffect = "move";
										if (over !== d) setOver(d);
									}}
									onDragLeave={() => over === d && setOver(null)}
									onDrop={(ev) => {
										ev.preventDefault();
										const e = dragged;
										setDragged(null);
										setOver(null);
										if (!e || !onMove || e.start.slice(0, 10) === d) return;
										onMove(e, shiftToDay(e, d));
									}}
								>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											onDay(d);
										}}
										title="Voir ce jour"
										className={`mb-0.5 inline-flex h-5 min-w-5 self-start rounded-full px-1 text-[12px] font-semibold leading-5 hover:underline ${
											d === today ? todayBadge : ""
										}`}
									>
										{Number(d.slice(8, 10)) === 1 ? `1er ${monthShort(d)}` : Number(d.slice(8, 10))}
									</button>
									{shown.map((e) => (
										<button
											type="button"
											key={`${e.id}-${d}`}
											draggable={!!onMove && !!e.editable && !e.ghost}
											onDragStart={(ev) => {
												ev.dataTransfer.effectAllowed = "move";
												ev.dataTransfer.setData("text/plain", e.id);
												setDragged(e);
											}}
											onDragEnd={() => {
												setDragged(null);
												setOver(null);
											}}
											onClick={(ev) => {
												ev.stopPropagation();
												onEventClick(e, (ev.currentTarget as HTMLElement).getBoundingClientRect());
											}}
											title={e.guests?.length ? `${e.title}\nAvec : ${e.guests.map((g) => g.name ?? g.address).join(", ")}` : e.title}
											data-meeting={e.guests?.length ? "" : undefined}
											style={e.allDay && e.color ? { background: `color-mix(in srgb, ${e.color} 20%, transparent)` } : undefined}
											className={`flex w-full min-w-0 items-center gap-1 rounded-[4px] px-1 py-px text-left text-[11px] leading-4 ${
												e.allDay ? chip : "hover:bg-black/5 dark:hover:bg-white/10"
											} ${e.showAs === "free" ? "opacity-70" : ""}`}
										>
											{!e.allDay && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.color ? "" : dot}`} style={e.color ? { background: e.color } : undefined} />}
											{!e.allDay && e.start.slice(0, 10) === d && <span className={`shrink-0 ${muted}`}>{e.start.slice(11, 16)}</span>}
											{!!e.proposals?.length && (
												<span title="Un participant propose un autre horaire" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
											)}
											<span className="truncate">
												<MeetingBadge event={e} />
												{e.title}
											</span>
										</button>
									))}
									{more > 0 && (
										<button
											type="button"
											onClick={(ev) => {
												ev.stopPropagation();
												onDay(d);
											}}
											className={`self-start px-1 text-[11px] font-medium ${muted} hover:underline`}
										>
											+{more} autre{more > 1 ? "s" : ""}
										</button>
									)}
								</div>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}

const MOIS_COURT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const monthShort = (d: string) => MOIS_COURT[Number(d.slice(5, 7)) - 1];
