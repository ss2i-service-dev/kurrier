"use client";
// ss2i : grille horaire de l'agenda Outlook, facon Notion Calendar (page Agenda et fenetre
// « Ajouter a l'agenda »). Une colonne par jour (1 a 14), journees entieres en tete, heures
// en dessous dans une zone defilante, trait rouge de l'heure courante. Couleur de l'agenda
// d'origine sur chaque evenement. A la souris :
// - clic sur un creneau libre : saisie a ce quart d'heure ; glisser sur un creneau libre :
//   saisie sur la plage tracee ;
// - glisser un evenement modifiable : deplacement (heure et jour), sa poignee du bas :
//   duree ; un simple clic : detail.
// Les propositions pas encore creees (ghost) sont en pointilles, celle en cours d'edition
// (active) en plein. Rendu des deux interfaces (classes k-* en Outlook).
// Zoom (Samuel le 24/11/2026) : hourHeight vient de la page, Ctrl+molette le change par onZoom
// en gardant sous le pointeur l'heure qui y etait ; plus on zoome, plus les lignes et les heures
// ecrites descendent au quart d'heure. Hors des heures de travail (workStart, workEnd), fond grise.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { User, Users, Video } from "lucide-react";
import { guestBuddies } from "@common/meeting-guests";
import { addDays } from "@common/thread-agenda";
import {
	type CalendarEvent,
	JOURS_COURTS,
	allDayCovers,
	hhmm,
	layoutDay,
	minutesNowInParis,
	slotFromOffset,
	todayInParis,
	weekday,
} from "@common/outlook-calendar";
import { anchoredScrollTop, gridLineStep, labelStep, wheelZoomStep, zoomStep } from "@/lib/agenda-zoom";

export type MoveTarget = { allDay: boolean; start: string; end: string };

export type CalendarGridProps = {
	days: string[];
	events: CalendarEvent[];
	nouvelle: boolean;
	/** Hauteur d'une heure (px). */
	hourHeight?: number;
	/** Creneau horaire libre clique : jour et minutes depuis minuit (quart d'heure). */
	onSlot?: (date: string, minutes: number) => void;
	/** Plage tracee a la souris sur un creneau libre. */
	onRange?: (date: string, startMinutes: number, endMinutes: number) => void;
	/** Case « journee entiere » d'un jour cliquee. */
	onAllDaySlot?: (date: string) => void;
	onEventClick?: (event: CalendarEvent, anchor: DOMRect) => void;
	/** Evenement modifiable depose a un autre horaire. */
	onMove?: (event: CalendarEvent, to: MoveTarget) => void;
	/** Heure montree en haut a l'ouverture (minutes), 7 h 30 par defaut. */
	scrollTo?: number;
	/**
	 * Cle de la periode affichee (page Agenda) : a chaque nouvelle cle, l'heure `scrollTo` est
	 * placee au tiers haut de la grille, puis on ne bouge plus (l'heure qui avance ne fait pas
	 * sauter le defilement de l'utilisateur).
	 */
	scrollKey?: string;
	loading?: boolean;
	className?: string;
	/** Fuseau d'affichage (ligne de l'heure courante). */
	tz?: string;
	/** Heures de travail (minutes) : en dehors, fond grise. */
	workStart?: number;
	workEnd?: number;
	/** Nouveau cran de zoom demande par Ctrl+molette sur la grille (sans lui, pas de zoom). */
	onZoom?: (hourHeight: number) => void;
};

const theme = (n: boolean) => ({
	line: n ? "border-k-line" : "border-border",
	muted: n ? "text-k-ink-3" : "text-muted-foreground",
	ink: n ? "text-k-ink" : "text-foreground",
	weekend: n ? "bg-k-surface-2" : "bg-muted/40",
	todayBadge: n ? "bg-k-accent text-white" : "bg-primary text-primary-foreground",
	hover: n ? "hover:bg-k-hover" : "hover:bg-muted/60",
	event: n ? "bg-k-accent-soft text-k-accent-soft-ink border-k-accent" : "bg-primary/15 text-foreground border-primary",
	free: n ? "bg-k-surface text-k-ink-2 border-k-line-strong" : "bg-background text-muted-foreground border-border",
	ghost: n ? "border-k-accent text-k-accent bg-k-surface/80" : "border-primary text-primary bg-background/80",
	active: n ? "bg-k-accent text-white border-k-accent" : "bg-primary text-primary-foreground border-primary",
	draft: n ? "bg-k-accent/25 border-k-accent" : "bg-primary/25 border-primary",
});

const STRIPES = "[background-image:repeating-linear-gradient(135deg,transparent_0_6px,rgba(255,255,255,.4)_6px_9px)]";

function eventClass(e: CalendarEvent, t: ReturnType<typeof theme>) {
	if (e.active) return `${t.active} border shadow-sm`;
	if (e.ghost) return `${t.ghost} border border-dashed`;
	const declined = e.responseStatus === "declined" ? "line-through opacity-60" : "";
	const pending = e.responseStatus === "notResponded" || e.responseStatus === "none" ? "border-dashed" : "";
	if (e.color) {
		// Couleur de l'agenda : fond leger et liseré plein ; invitation sans reponse en pointilles.
		return `border border-l-[3px] text-inherit ${e.showAs === "tentative" ? STRIPES : ""} ${e.showAs === "free" ? "opacity-70" : ""} ${!e.isOrganizer ? pending : ""} ${declined}`;
	}
	if (e.showAs === "free") return `${t.free} border ${declined}`;
	if (e.showAs === "tentative") return `${t.event} border-l-[3px] opacity-80 ${STRIPES} ${declined}`;
	return `${t.event} border-l-[3px] ${declined}`;
}

/** Couleur d'agenda en style (fond, bordure) ; rien pour les propositions. */
const colorStyle = (e: CalendarEvent): React.CSSProperties =>
	e.color && !e.ghost && !e.active
		? {
				background: `color-mix(in srgb, ${e.color} ${e.showAs === "free" ? 8 : 18}%, var(--k-surface, var(--background)))`,
				borderColor: `color-mix(in srgb, ${e.color} 45%, transparent)`,
				borderLeftColor: e.color,
			}
		: {};

/** Pastille « un participant propose un autre horaire » (reunion que j'organise). */
function ProposalBadge() {
	return (
		<span
			title="Un participant propose un autre horaire"
			className="mr-1 inline-flex h-3.5 min-w-3.5 -translate-y-px items-center justify-center rounded-full bg-amber-500 px-1 align-middle text-[9px] font-bold text-white"
		>
			!
		</span>
	);
}

/**
 * Reunion avec d'autres personnes (Samuel le 24/11/2026 : « ca depend de quelqu'un d'autre ») :
 * camera si un lien de visio est connu, sinon deux bonshommes. Rien pour une entree perso.
 */
export function MeetingBadge({ event, className = "" }: { event: CalendarEvent; className?: string }) {
	const n = event.guests?.length ?? 0;
	if (!n) return null;
	const Icon = event.joinUrl ? Video : Users;
	return (
		<Icon
			aria-label={`Réunion avec ${n} personne${n > 1 ? "s" : ""}`}
			className={`mr-1 inline-block h-3 w-3 shrink-0 -translate-y-px align-middle ${className}`}
			strokeWidth={2.4}
		/>
	);
}

/** Un petit bonhomme par invite (4 et « +N » au-dela de 5). */
export function GuestBuddies({ event, className = "" }: { event: CalendarEvent; className?: string }) {
	const { shown, more } = guestBuddies(event.guests?.length ?? 0);
	if (!shown) return null;
	return (
		<span data-guests="" className={`flex items-center gap-px opacity-80 ${className}`}>
			{Array.from({ length: shown }, (_, i) => (
				<User key={i} aria-hidden className="h-2.5 w-2.5 shrink-0" strokeWidth={2.6} />
			))}
			{more > 0 && <span className="ml-0.5 text-[9.5px] font-semibold">+{more}</span>}
		</span>
	);
}

/** Liseré des reunions : contour fin en plus de la couleur de l'agenda. */
export const meetingRing = (e: CalendarEvent) => (e.guests?.length && !e.ghost && !e.active ? "ring-1 ring-inset ring-current/50" : "");

const guestNames = (e: CalendarEvent) => (e.guests ?? []).map((g) => g.name ?? g.address).join(", ");

const tooltip = (e: CalendarEvent) =>
	[e.proposals?.length ? `Nouvel horaire proposé par ${e.proposals.map((p) => p.name ?? p.address).join(", ")}` : "", e.title, e.allDay ? "Journée entière" : `${e.start.slice(11, 16)} – ${e.end.slice(11, 16)}`, e.location, e.organizer && `Organisateur : ${e.organizer}`, e.guests?.length ? `Avec : ${guestNames(e)}` : ""]
		.filter(Boolean)
		.join("\n");

function useNow(tz?: string) {
	const read = () => ({ day: todayInParis(new Date(), tz), min: minutesNowInParis(new Date(), tz) });
	const [now, setNow] = useState(read);
	useEffect(() => {
		setNow(read());
		const t = setInterval(() => setNow(read()), 60_000);
		return () => clearInterval(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tz]);
	return now;
}

type Drag =
	| { kind: "move" | "resize"; event: CalendarEvent; x: number; y: number; day: string; top: number; bottom: number; moved: boolean; preview: { day: string; top: number; bottom: number } }
	| { kind: "create"; day: string; y0: number; from: number; to: number; moved: boolean };

const snap = (m: number) => Math.round(m / 15) * 15;
const DAY_END = 24 * 60;

export default function CalendarGrid({
	days,
	events,
	nouvelle,
	hourHeight = 44,
	onSlot,
	onRange,
	onAllDaySlot,
	onEventClick,
	onMove,
	scrollTo = 7 * 60 + 30,
	scrollKey,
	loading,
	className = "",
	tz,
	workStart,
	workEnd,
	onZoom,
}: CalendarGridProps) {
	const t = theme(nouvelle);
	const now = useNow(tz);
	const scroller = useRef<HTMLDivElement>(null);
	const columns = useRef(new Map<string, HTMLDivElement>());
	const [drag, setDrag] = useState<Drag | null>(null);
	const dragRef = useRef<Drag | null>(null);
	dragRef.current = drag;
	const swallowClick = useRef(false);
	// Appui d'un doigt sur une colonne : la creation attend le click (voir la colonne).
	const tapSlot = useRef(false);
	const many = days.length > 7;

	// Zoom : l'heure qui etait sous le pointeur (Ctrl+molette) ou au milieu (boutons) y reste.
	const zoomAnchor = useRef<number | null>(null);
	const prevHour = useRef(hourHeight);
	useLayoutEffect(() => {
		const el = scroller.current;
		const prev = prevHour.current;
		prevHour.current = hourHeight;
		if (!el || prev === hourHeight) return;
		el.scrollTop = anchoredScrollTop(prev, hourHeight, el.scrollTop, zoomAnchor.current ?? el.clientHeight / 2);
		zoomAnchor.current = null;
	}, [hourHeight]);
	// Ctrl+molette (et pincement du pave tactile) : ecouteur natif non passif, sinon le
	// navigateur zoome toute la page.
	const zoomRef = useRef({ hourHeight, onZoom, acc: 0 });
	zoomRef.current.hourHeight = hourHeight;
	zoomRef.current.onZoom = onZoom;
	const canZoom = !!onZoom;
	useEffect(() => {
		const el = scroller.current;
		if (!el || !canZoom) return;
		const wheel = (ev: WheelEvent) => {
			if (!ev.ctrlKey && !ev.metaKey) return;
			ev.preventDefault();
			const z = zoomRef.current;
			if (dragRef.current || !z.onZoom) return; // pas de zoom pendant un glisser
			const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
			const r = wheelZoomStep(z.acc, dy);
			z.acc = r.acc;
			if (!r.step) return;
			const next = zoomStep(z.hourHeight, r.step);
			if (next === z.hourHeight) return;
			zoomAnchor.current = ev.clientY - el.getBoundingClientRect().top;
			z.onZoom(next);
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, [canZoom]);

	// Position de defilement : a l'ouverture et quand l'heure demandee change (proposition deplacee hors champ).
	const lastKey = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const y = (scrollTo / 60) * hourHeight;
		if (scrollKey !== undefined) {
			if (lastKey.current === scrollKey) return;
			lastKey.current = scrollKey;
			el.scrollTop = Math.max(0, y - el.clientHeight / 3);
			return;
		}
		if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - hourHeight) el.scrollTop = Math.max(0, y - hourHeight / 2);
	}, [scrollTo, hourHeight, scrollKey]);

	const dayAt = (x: number): string | null => {
		for (const [d, el] of columns.current) {
			const r = el.getBoundingClientRect();
			if (x >= r.left && x < r.right) return d;
		}
		return null;
	};

	// Suivi de la souris pendant un glisser (fenetre entiere : on peut sortir de la colonne).
	useEffect(() => {
		if (!drag) return;
		const move = (ev: PointerEvent) => {
			const d = dragRef.current;
			if (!d) return;
			if (d.kind === "create") {
				const col = columns.current.get(d.day);
				if (!col) return;
				const m = Math.max(0, Math.min(DAY_END, snap(((ev.clientY - col.getBoundingClientRect().top) / hourHeight) * 60)));
				setDrag({ ...d, to: m, moved: d.moved || Math.abs(ev.clientY - d.y0) > 4 });
				return;
			}
			const dm = snap(((ev.clientY - d.y) / hourHeight) * 60);
			const moved = d.moved || Math.abs(ev.clientY - d.y) > 4 || Math.abs(ev.clientX - d.x) > 4;
			if (d.kind === "resize") {
				const bottom = Math.max(d.top + 15, Math.min(DAY_END, d.bottom + dm));
				setDrag({ ...d, moved, preview: { day: d.day, top: d.top, bottom } });
				return;
			}
			const len = d.bottom - d.top;
			const top = Math.max(0, Math.min(DAY_END - len, d.top + dm));
			setDrag({ ...d, moved, preview: { day: dayAt(ev.clientX) ?? d.preview.day, top, bottom: top + len } });
		};
		const up = () => {
			const d = dragRef.current;
			setDrag(null);
			if (!d) return;
			if (d.kind === "create") {
				const a = Math.min(d.from, d.to);
				const b = Math.max(d.from, d.to);
				if (d.moved && b - a >= 15 && onRange) onRange(d.day, a, b);
				else onSlot?.(d.day, Math.min(d.from, DAY_END - 15));
				return;
			}
			if (!d.moved) return; // simple clic : le onClick de l'evenement ouvre le detail
			swallowClick.current = true;
			setTimeout(() => (swallowClick.current = false), 0);
			const p = d.preview;
			if (p.day === d.day && p.top === d.top && p.bottom === d.bottom) return;
			onMove?.(d.event, { allDay: false, start: `${p.day}T${hhmm(p.top)}`, end: p.bottom >= DAY_END ? `${addDays(p.day, 1)}T00:00` : `${p.day}T${hhmm(p.bottom)}` });
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up, { once: true });
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [drag !== null]);

	const allDay = events.filter((e) => e.allDay);
	const hasAllDay = days.some((d) => allDay.some((e) => allDayCovers(e, d)));
	// Week-end plus etroit : 14 colonnes restent lisibles.
	const grow = (d: string) => (many && (weekday(d) === 0 || weekday(d) === 6) ? 0.55 : 1);

	const clickEvent = (e: CalendarEvent) => (ev: React.MouseEvent) => {
		ev.stopPropagation();
		if (swallowClick.current) return;
		onEventClick?.(e, (ev.currentTarget as HTMLElement).getBoundingClientRect());
	};

	const startDrag = (e: CalendarEvent, d: string, top: number, bottom: number, kind: "move" | "resize") => (ev: React.PointerEvent) => {
		// Jamais jusqu'a la colonne : un appui sur un evenement ne trace pas de nouvelle plage.
		ev.stopPropagation();
		if (ev.pointerType !== "mouse" || ev.button !== 0 || !onMove || !e.editable || e.ghost) return;
		// Un evenement de plusieurs jours ne se deplace qu'entier depuis son premier jour.
		if (e.start.slice(0, 10) !== e.end.slice(0, 10) && !(e.end.slice(0, 10) === addDays(e.start.slice(0, 10), 1) && e.end.endsWith("T00:00"))) return;
		setDrag({ kind, event: e, x: ev.clientX, y: ev.clientY, day: d, top, bottom, moved: false, preview: { day: d, top, bottom } });
	};

	// Evenements avec l'apercu du glisser en cours.
	const shown =
		drag && drag.kind !== "create" && drag.moved
			? events.map((e) =>
					e.id === drag.event.id
						? {
								...e,
								start: `${drag.preview.day}T${hhmm(drag.preview.top)}`,
								end: drag.preview.bottom >= DAY_END ? `${addDays(drag.preview.day, 1)}T00:00` : `${drag.preview.day}T${hhmm(drag.preview.bottom)}`,
								active: true,
							}
						: e,
				)
			: events;

	const gutter = "w-12 shrink-0";
	const lineStep = gridLineStep(hourHeight);
	const lblStep = labelStep(hourHeight);
	const work = workStart !== undefined && workEnd !== undefined && workStart < workEnd ? { start: workStart, end: workEnd } : null;

	return (
		<div className={`flex min-h-0 flex-col text-[12px] ${t.ink} ${drag?.moved ? "select-none" : ""} ${className}`} aria-busy={loading || undefined}>
			{/* En-tetes des jours */}
			<div className={`flex overflow-y-hidden border-b [scrollbar-gutter:stable] ${t.line}`}>
				<div className={gutter} />
				{days.map((d) => {
					const today = d === now.day;
					return (
						<div key={d} className={`min-w-0 px-1 py-1.5 text-center ${t.muted}`} style={{ flex: `${grow(d)} 1 0` }}>
							<span className="block truncate text-[11px] uppercase tracking-wide">{JOURS_COURTS[weekday(d)]}</span>
							<span className={`mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[13px] font-semibold ${today ? t.todayBadge : t.ink}`}>
								{Number(d.slice(8, 10))}
							</span>
						</div>
					);
				})}
			</div>

			{/* Journees entieres */}
			{(hasAllDay || onAllDaySlot) && (
				<div className={`flex overflow-y-hidden border-b [scrollbar-gutter:stable] ${t.line}`}>
					<div className={`${gutter} py-1 pr-1 text-right text-[10px] ${t.muted}`}>Jour</div>
					{days.map((d) => (
						// biome-ignore lint/a11y/noStaticElementInteractions: case cliquable de la grille, le clavier passe par « Nouvel evenement »
						// biome-ignore lint/a11y/useKeyWithClickEvents: idem
						<div
							key={d}
							className={`min-w-0 space-y-px border-l p-0.5 ${t.line} ${onAllDaySlot ? `cursor-pointer ${t.hover}` : ""}`}
							style={{ flex: `${grow(d)} 1 0`, minHeight: 22 }}
							onClick={onAllDaySlot ? () => onAllDaySlot(d) : undefined}
						>
							{allDay
								.filter((e) => allDayCovers(e, d))
								.map((e) => (
									<button
										type="button"
										key={`${e.id}-${d}`}
										title={tooltip(e)}
										onClick={clickEvent(e)}
										style={colorStyle(e)}
										data-meeting={e.guests?.length ? "" : undefined}
										className={`block w-full truncate rounded-[4px] px-1 py-px text-left text-[11px] leading-4 ${eventClass(e, t)} ${meetingRing(e)}`}
									>
										<MeetingBadge event={e} />
										{e.title}
									</button>
								))}
						</div>
					))}
				</div>
			)}

			{/* Heures */}
			<div ref={scroller} className="k-scroll relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
				<div className="relative flex" style={{ height: 24 * hourHeight }}>
					<div className={`${gutter} relative`}>
						{Array.from({ length: (24 * 60) / lblStep - 1 }, (_, i) => (i + 1) * lblStep).map((m) => (
							<div
								key={m}
								className={`absolute right-1.5 -translate-y-1/2 ${m % 60 ? "text-[9.5px] opacity-70" : "text-[10.5px]"} ${t.muted}`}
								style={{ top: (m / 60) * hourHeight }}
							>
								{hhmm(m)}
							</div>
						))}
					</div>
					{days.map((d) => {
						const wk = weekday(d) === 0 || weekday(d) === 6;
						const placed = layoutDay(shown, d);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: colonne de la grille (souris), le clavier passe par « Nouvel evenement »
							<div
								key={d}
								ref={(el) => {
									if (el) columns.current.set(d, el);
									else columns.current.delete(d);
								}}
								className={`relative min-w-0 border-l ${t.line} ${wk ? t.weekend : ""} ${onSlot ? "cursor-pointer" : ""}`}
								style={{ flex: `${grow(d)} 1 0` }}
								onPointerDown={
									onSlot
										? (ev) => {
												if (ev.button !== 0) return;
												const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
												const m = slotFromOffset(ev.clientY - rect.top, hourHeight);
												// Doigt ou stylet : rien a l'appui, le geste peut etre un defilement
												// (Samuel le 19/11/2026 : defiler sa journee ouvrait un nouvel evenement).
												// La creation attend le click, que le navigateur n'emet pas apres un defilement.
												if (ev.pointerType !== "mouse") {
													tapSlot.current = true;
													return;
												}
												tapSlot.current = false;
												if (!onRange) {
													onSlot(d, m);
													return;
												}
												ev.preventDefault();
												setDrag({ kind: "create", day: d, y0: ev.clientY, from: m, to: m + 15, moved: false });
											}
										: undefined
								}
								onClick={
									onSlot
										? (ev) => {
												if (!tapSlot.current) return;
												tapSlot.current = false;
												const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
												onSlot(d, slotFromOffset(ev.clientY - rect.top, hourHeight));
											}
										: undefined
								}
							>
								{/* hors des heures de travail : fond grise (le week-end l'est deja en entier) */}
								{work && !wk && (
									<>
										<div data-off-hours="" className={`pointer-events-none absolute inset-x-0 top-0 ${t.weekend}`} style={{ height: (work.start / 60) * hourHeight }} />
										<div
											data-off-hours=""
											className={`pointer-events-none absolute inset-x-0 bottom-0 ${t.weekend}`}
											style={{ top: (work.end / 60) * hourHeight }}
										/>
									</>
								)}
								{/* lignes des heures, demi-heures (pointilles) et quarts d'heure quand on zoome */}
								{Array.from({ length: (24 * 60) / lineStep }, (_, i) => i * lineStep).map((m) => (
									<div
										key={`l${m}`}
										className={`pointer-events-none absolute inset-x-0 border-t ${t.line} ${m % 60 === 0 ? "" : m % 30 === 0 ? "border-dotted opacity-50" : "border-dotted opacity-25"}`}
										style={{ top: (m / 60) * hourHeight }}
									/>
								))}
								{drag?.kind === "create" && drag.day === d && (
									<div
										className={`pointer-events-none absolute inset-x-0.5 z-20 rounded-[5px] border px-1 text-[11px] font-medium ${t.draft}`}
										style={{
											top: (Math.min(drag.from, drag.to) / 60) * hourHeight,
											height: Math.max(((Math.abs(drag.to - drag.from) || 15) / 60) * hourHeight, 12),
										}}
									>
										{hhmm(Math.min(drag.from, drag.to))} – {hhmm(Math.max(drag.from, drag.to, Math.min(drag.from, drag.to) + 15))}
									</div>
								)}
								{placed.map((p) => {
									const h = ((p.bottom - p.top) / 60) * hourHeight;
									const short = h < 30;
									const draggable = !!onMove && !!p.event.editable && !p.event.ghost;
									return (
										<button
											type="button"
											key={`${p.event.id}-${d}`}
											title={tooltip(p.event)}
											onClick={clickEvent(p.event)}
											onPointerDown={startDrag(p.event, d, p.top, p.bottom, "move")}
											data-meeting={p.event.guests?.length ? "" : undefined}
											className={`group absolute overflow-hidden rounded-[5px] px-1 text-left leading-[1.15] ${eventClass(p.event, t)} ${meetingRing(p.event)} ${
												p.event.active ? "z-20" : p.event.ghost ? "z-10" : ""
											} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
											style={{
												top: (p.top / 60) * hourHeight + 1,
												height: Math.max(h - 2, 14),
												left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
												width: `calc(${100 / p.cols}% - 3px)`,
												...colorStyle(p.event),
											}}
										>
											<span className={`flex items-center gap-1 font-medium ${short ? "text-[10.5px]" : "text-[11.5px]"}`}>
												<span className="min-w-0 flex-1 truncate">
													{!!p.event.proposals?.length && <ProposalBadge />}
													<MeetingBadge event={p.event} />
													{short ? `${hhmm(p.top)} ${p.event.title}` : p.event.title}
												</span>
												<GuestBuddies event={p.event} className="shrink-0" />
											</span>
											{!short && h >= 44 && !!p.event.proposals?.length && (
												<span className="block truncate text-[10px] font-semibold text-amber-700 dark:text-amber-400">Nouvel horaire proposé</span>
											)}
											{!short && (
												<span className="block truncate text-[10.5px] opacity-80">
													{hhmm(p.top)} – {hhmm(p.bottom)}
													{p.event.location && !many ? ` · ${p.event.location}` : ""}
												</span>
											)}
											{draggable && (
												<span
													aria-hidden
													onPointerDown={startDrag(p.event, d, p.top, p.bottom, "resize")}
													className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize opacity-0 group-hover:opacity-100"
												/>
											)}
										</button>
									);
								})}
								{d === now.day && (
									<div className="pointer-events-none absolute inset-x-0 z-30" style={{ top: (now.min / 60) * hourHeight }}>
										<div className="relative border-t-2 border-red-500">
											<span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-red-500" />
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
