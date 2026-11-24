"use client";
// ss2i : barre de navigation de l'agenda Outlook (page Agenda et fenetre « Ajouter a
// l'agenda ») : Aujourd'hui, precedent / suivant, periode affichee, nombre de jours, zoom de
// la grille horaire.
import React from "react";
import { ChevronLeft, ChevronRight, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { CALENDAR_VIEWS, type CalendarView } from "@common/outlook-calendar";

const LABEL: Record<string, string> = { 1: "Jour", 3: "3 jours", 7: "Semaine", 14: "2 semaines", month: "Mois" };

export default function CalendarToolbar({
	nouvelle,
	label,
	view,
	onPrev,
	onNext,
	onToday,
	onView,
	onReload,
	loading,
	extra,
	onZoomIn,
	onZoomOut,
}: {
	nouvelle: boolean;
	/** Periode affichee (« 2 – 15 novembre 2026 », « novembre 2026 »). */
	label: string;
	view?: CalendarView;
	onPrev: () => void;
	onNext: () => void;
	onToday: () => void;
	onView?: (v: CalendarView) => void;
	onReload?: () => void;
	loading?: boolean;
	extra?: React.ReactNode;
	/** Zoom de la grille horaire (absent : pas de boutons, ou undefined au cran extreme : grise). */
	onZoomIn?: (() => void) | null;
	onZoomOut?: (() => void) | null;
}) {
	const btn = nouvelle
		? "k-focus inline-flex h-7 items-center justify-center rounded-k-sm px-2 text-[12.5px] text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
		: "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground";
	const border = nouvelle ? "border border-k-line" : "border";
	const selected = nouvelle ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "bg-background font-medium text-foreground shadow-sm";
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<button type="button" className={`${btn} ${border}`} onClick={onToday}>
				Aujourd'hui
			</button>
			<button type="button" className={btn} onClick={onPrev} aria-label="Période précédente" title="Période précédente">
				<ChevronLeft className="h-4 w-4" />
			</button>
			<button type="button" className={btn} onClick={onNext} aria-label="Période suivante" title="Période suivante">
				<ChevronRight className="h-4 w-4" />
			</button>
			<span className={`ml-1 truncate font-semibold ${nouvelle ? "text-[14px] text-k-ink" : "text-sm"}`}>{label}</span>
			{onReload && (
				<button type="button" className={btn} onClick={onReload} aria-label="Actualiser" title="Actualiser depuis Outlook">
					<RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
				</button>
			)}
			<span className="flex-1" />
			{onZoomIn !== undefined && onZoomOut !== undefined && (
				<div className="inline-flex" role="group" aria-label="Zoom de la grille horaire">
					<button type="button" className={`${btn} disabled:opacity-40`} onClick={onZoomOut ?? undefined} disabled={!onZoomOut} aria-label="Zoom arrière" title="Zoom arrière (Ctrl+molette)">
						<ZoomOut className="h-4 w-4" />
					</button>
					<button type="button" className={`${btn} disabled:opacity-40`} onClick={onZoomIn ?? undefined} disabled={!onZoomIn} aria-label="Zoom avant" title="Zoom avant, jusqu'au quart d'heure (Ctrl+molette)">
						<ZoomIn className="h-4 w-4" />
					</button>
				</div>
			)}
			{extra}
			{onView && (
				<div className={`inline-flex rounded-md p-0.5 ${nouvelle ? "bg-k-hover" : "bg-muted"}`} role="group" aria-label="Vue">
					{CALENDAR_VIEWS.map((n) => (
						<button
							type="button"
							key={n}
							aria-pressed={view === n}
							onClick={() => onView(n)}
							className={`h-6 rounded-[5px] px-2 text-[12px] ${view === n ? selected : nouvelle ? "text-k-ink-2" : "text-muted-foreground"}`}
						>
							{LABEL[String(n)]}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
