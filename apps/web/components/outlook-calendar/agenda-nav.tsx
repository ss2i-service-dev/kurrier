"use client";
// ss2i : barre laterale de la page Agenda, facon Notion Calendar : « Nouvel evenement »,
// mini-calendrier du mois (la periode affichee y est surlignee, un clic y va), choix de
// l'agenda Outlook, et les prochains rendez-vous des 7 jours. Etat partage avec la page par
// agenda-store. Rendu des deux interfaces.
import React, { useEffect, useMemo, useState } from "react";
import { Bell, CalendarPlus, ChevronLeft, ChevronRight, MapPin, Plus, X } from "lucide-react";
import {
	JOURS_COURTS,
	TIME_ZONES,
	addMonths,
	minutesNowInParis,
	monthGrid,
	monthLabel,
	monthStart,
	todayInParis,
	viewDays,
	weekday,
} from "@common/outlook-calendar";
import { addDays } from "@common/thread-agenda";
import type { CalendarEvent } from "@common/outlook-calendar";
import { type CalendarSource, type OutlookCalendarBox, checkColleagueCalendar } from "@/lib/actions/outlook-calendar";
import { agendaStore, useAgendaState } from "@/components/outlook-calendar/agenda-store";
import { useOutlookEvents } from "@/components/outlook-calendar/use-outlook-events";

const theme = (n: boolean) => ({
	title: n ? "text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3" : "text-xs font-medium text-muted-foreground",
	muted: n ? "text-k-ink-3" : "text-muted-foreground",
	ink: n ? "text-k-ink" : "text-foreground",
	hover: n ? "hover:bg-k-hover" : "hover:bg-muted",
	range: n ? "bg-k-accent-soft" : "bg-primary/10",
	today: n ? "bg-k-accent text-white" : "bg-primary text-primary-foreground",
	dot: n ? "bg-k-accent" : "bg-primary",
	selected: n ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "bg-muted font-medium",
});

/** Bouton principal (emplacement « Nouveau message ») : evenement au prochain quart d'heure. */
export function KAgendaNew({ nouvelle }: { nouvelle: boolean }) {
	const { tz } = useAgendaState();
	const click = () => {
		const m = Math.ceil((minutesNowInParis(new Date(), tz) + 1) / 15) * 15;
		const today = todayInParis(new Date(), tz);
		if (m >= 23 * 60) agendaStore.requestNew(addDays(today, 1), 9 * 60);
		else agendaStore.requestNew(today, m);
	};
	return (
		<button
			type="button"
			onClick={click}
			className={
				nouvelle
					? "k-focus flex w-full items-center justify-center gap-2 rounded-k bg-k-accent px-3 py-2 text-[13.5px] font-medium text-white transition-colors hover:bg-k-accent-hover"
					: "flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
			}
		>
			<CalendarPlus className="h-4 w-4" />
			Nouvel événement
		</button>
	);
}

function MiniMonth({ nouvelle }: { nouvelle: boolean }) {
	const t = theme(nouvelle);
	const { view, anchor, loaded, tz } = useAgendaState();
	const [month, setMonth] = useState(() => monthStart(anchor));
	// La page change de periode : le mini-calendrier la suit.
	useEffect(() => setMonth(monthStart(anchor)), [anchor]);
	const shown = useMemo(() => new Set(loaded ? viewDays(view, anchor) : []), [view, anchor, loaded]);
	const today = todayInParis(new Date(), tz);
	const days = monthGrid(month);

	return (
		<div>
			<div className="mb-1 flex items-center px-1">
				<span className={`flex-1 text-[13px] font-semibold capitalize ${t.ink}`}>{monthLabel(month)}</span>
				<button type="button" aria-label="Mois précédent" className={`rounded p-0.5 ${t.muted} ${t.hover}`} onClick={() => setMonth(addMonths(month, -1))}>
					<ChevronLeft className="h-4 w-4" />
				</button>
				<button type="button" aria-label="Mois suivant" className={`rounded p-0.5 ${t.muted} ${t.hover}`} onClick={() => setMonth(addMonths(month, 1))}>
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
			<div className="grid grid-cols-7 text-center text-[10.5px]">
				{[1, 2, 3, 4, 5, 6, 0].map((d) => (
					<span key={d} className={`py-0.5 ${t.muted}`}>
						{JOURS_COURTS[d].slice(0, 1).toUpperCase()}
					</span>
				))}
				{days.map((d) => {
					const inMonth = d.slice(0, 7) === month.slice(0, 7);
					const inRange = shown.has(d) && view !== "month";
					return (
						<button
							type="button"
							key={d}
							onClick={() => agendaStore.setAnchor(d)}
							className={`flex h-7 items-center justify-center text-[12px] ${inRange ? t.range : ""} ${inMonth ? t.ink : `${t.muted} opacity-60`}`}
						>
							<span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${d === today ? t.today : t.hover}`}>{Number(d.slice(8, 10))}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function dayTitle(date: string, today: string): string {
	if (date === today) return "Aujourd'hui";
	if (date === addDays(today, 1)) return "Demain";
	const label = `${JOURS_COURTS[weekday(date)]} ${Number(date.slice(8, 10))}`;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * « A traiter » : ce qui attend une action, sur 14 jours dans mes agendas. Propositions
 * d'horaire faites par un participant (reunions que j'organise) et invitations sans reponse.
 * Un clic ouvre la fiche, ou se trouvent les boutons.
 */
/** Mes agendas sur 14 jours a partir d'aujourd'hui : une lecture partagee par « A traiter » et « A venir ». */
function useOwnUpcoming(boxId: string | undefined, ready: boolean, sources: CalendarSource[], version: number, tz: string, today: string) {
	const refs = useMemo(
		() => sources.filter((s) => s.kind === "own").map((s) => ({ kind: "own" as const, calendarId: s.kind === "own" ? s.calendarId : undefined })),
		[sources],
	);
	return useOutlookEvents(ready && refs.length ? boxId : undefined, today, 14, refs, version, tz);
}

function ToDo({ nouvelle }: { nouvelle: boolean }) {
	const t = theme(nouvelle);
	const { boxId, loaded, sources, sourcesBox, version, tz } = useAgendaState();
	const today = todayInParis(new Date(), tz);
	const { events } = useOwnUpcoming(boxId, loaded && sourcesBox === boxId, sources, version, tz, today);
	const nowMin = minutesNowInParis(new Date(), tz);
	const now = `${today}T${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")}`;
	const items = events
		.filter((e) => (e.allDay ? e.end >= today : e.end > now))
		.flatMap((e): { e: CalendarEvent; kind: "proposal" | "invite" }[] => {
			if (e.proposals?.length) return [{ e, kind: "proposal" as const }];
			if (e.isOrganizer === false && (e.responseStatus === "notResponded" || e.responseStatus === "none")) return [{ e, kind: "invite" as const }];
			return [];
		})
		.sort((a, b) => Number(b.kind === "proposal") - Number(a.kind === "proposal") || a.e.start.localeCompare(b.e.start))
		.slice(0, 10);
	if (!items.length) return null;
	const when = (v: string, allDay?: boolean) => `${dayTitle(v.slice(0, 10), today)}${allDay ? "" : ` ${v.slice(11, 16)}`}`;
	return (
		<div>
			<div className={`mb-1.5 flex items-center gap-1.5 px-1 ${t.title}`}>
				À traiter
				<span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-4 text-white">{items.length}</span>
			</div>
			<div className="space-y-1">
				{items.map(({ e, kind }) => (
					<button
						type="button"
						key={`${kind}-${e.id}`}
						onClick={(ev) => {
							agendaStore.setAnchor(e.start.slice(0, 10));
							agendaStore.requestDetail(e, (ev.currentTarget as HTMLElement).getBoundingClientRect());
						}}
						className={`w-full rounded-md border px-2 py-1.5 text-left ${
							kind === "proposal" ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40" : nouvelle ? "border-k-line" : "border-border"
						} ${t.hover}`}
					>
						<span className={`block text-[10.5px] font-semibold uppercase tracking-wide ${kind === "proposal" ? "text-amber-700 dark:text-amber-400" : t.muted}`}>
							{kind === "proposal" ? "Nouvel horaire proposé" : "Invitation sans réponse"}
						</span>
						<span className={`block truncate text-[12.5px] font-medium ${t.ink}`}>{e.title}</span>
						<span className={`block truncate text-[11px] ${t.muted}`}>
							{kind === "proposal" && e.proposals
								? `${e.proposals[0].name ?? e.proposals[0].address} : ${when(e.proposals[0].start)} au lieu de ${when(e.start)}`
								: `${when(e.start, e.allDay)}${e.organizer ? ` · ${e.organizer}` : ""}`}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

function Upcoming({ nouvelle }: { nouvelle: boolean }) {
	const t = theme(nouvelle);
	const { boxId, loaded, sources, sourcesBox, hidden, version, tz } = useAgendaState();
	const today = todayInParis(new Date(), tz);
	// Meme lecture que « A traiter » (une seule requete), filtree ici : mes agendas affiches, 7 jours.
	const own = useOwnUpcoming(boxId, loaded && sourcesBox === boxId, sources, version, tz, today);
	const error = own.error;
	const events = own.events.filter((e) => !hidden.includes(e.sourceKey ?? "") && e.start.slice(0, 10) < addDays(today, 7));
	const nowMin = minutesNowInParis(new Date(), tz);
	const now = `${today}T${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")}`;
	const next = events
		.filter((e) => (e.allDay ? e.end >= today : e.end > now) && e.showAs !== "free")
		.sort((a, b) => a.start.localeCompare(b.start))
		.slice(0, 8);
	const groups: { day: string; items: typeof next }[] = [];
	for (const e of next) {
		const day = e.start.slice(0, 10) < today ? today : e.start.slice(0, 10);
		const g = groups.find((x) => x.day === day);
		if (g) g.items.push(e);
		else groups.push({ day, items: [e] });
	}

	return (
		<div>
			<div className={`mb-1.5 px-1 ${t.title}`}>À venir</div>
			{error && <p className={`px-1 text-[12px] ${t.muted}`}>Agenda indisponible.</p>}
			{!error && !groups.length && <p className={`px-1 text-[12px] ${t.muted}`}>Rien de prévu cette semaine.</p>}
			<div className="space-y-2">
				{groups.map((g) => (
					<div key={g.day}>
						<div className={`px-1 text-[11.5px] font-medium ${t.muted}`}>{dayTitle(g.day, today)}</div>
						{g.items.map((e) => (
							<button
								type="button"
								key={e.id}
								onClick={(ev) => {
									// La periode affichee suit, et la fiche s'ouvre a cote de la barre laterale.
									agendaStore.setAnchor(g.day);
									agendaStore.requestDetail(e, (ev.currentTarget as HTMLElement).getBoundingClientRect());
								}}
								title="Voir le détail"
								className={`flex w-full items-start gap-2 rounded-md px-1 py-1 text-left ${t.hover}`}
							>
								<span
									className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${sources.find((s) => s.key === e.sourceKey)?.color ? "" : t.dot}`}
									style={{ background: sources.find((s) => s.key === e.sourceKey)?.color }}
								/>
								<span className="min-w-0 flex-1">
									<span className={`block truncate text-[12.5px] ${t.ink}`}>{e.title}</span>
									<span className={`flex items-center gap-1 text-[11px] ${t.muted}`}>
										{e.allDay ? "Journée entière" : `${e.start.slice(11, 16)} – ${e.end.slice(11, 16)}`}
										{e.location && (
											<>
												<MapPin className="h-3 w-3 shrink-0" />
												<span className="truncate">{e.location}</span>
											</>
										)}
									</span>
								</span>
							</button>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

function SourceRow({ s, nouvelle, removable }: { s: CalendarSource; nouvelle: boolean; removable?: boolean }) {
	const t = theme(nouvelle);
	const st = useAgendaState();
	const shown = s.kind === "colleague" ? st.shownColleagues.includes(s.key) : !st.hidden.includes(s.key);
	return (
		<div className={`group flex items-center gap-2 rounded-md px-1.5 py-1 ${t.hover}`}>
			<button type="button" onClick={() => agendaStore.toggleSource(s.key)} aria-pressed={shown} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={shown ? "Masquer" : "Afficher"}>
				<span
					className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-2"
					style={{ borderColor: s.color, background: shown ? s.color : "transparent" }}
				>
					{shown && <span className="block h-1.5 w-1.5 rounded-[1px] bg-white" />}
				</span>
				<span className="min-w-0 flex-1">
					<span className={`block truncate text-[12.5px] ${shown ? t.ink : t.muted}`}>{s.name}</span>
					{s.kind === "colleague" && <span className={`block truncate text-[10.5px] ${t.muted}`}>{s.roleLabel}</span>}
				</span>
			</button>
			{removable && s.kind === "colleague" && (
				<button
					type="button"
					aria-label={`Retirer ${s.name}`}
					title="Retirer de la liste"
					className={`shrink-0 opacity-0 group-hover:opacity-100 ${t.muted}`}
					onClick={() => agendaStore.removeColleague(s.owner)}
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}

function AddColleague({ nouvelle }: { nouvelle: boolean }) {
	const t = theme(nouvelle);
	const { boxId } = useAgendaState();
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		const a = value.trim().toLowerCase();
		if (!a || !boxId || busy) return;
		setBusy(true);
		setError(null);
		const res = await checkColleagueCalendar({ identityPublicId: boxId, address: a }).catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
		setBusy(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		agendaStore.addColleague(a);
		setValue("");
		setOpen(false);
	};
	if (!open) {
		return (
			<button type="button" onClick={() => setOpen(true)} className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] ${t.muted} ${t.hover}`}>
				<Plus className="h-3.5 w-3.5" /> Ajouter un collègue
			</button>
		);
	}
	return (
		<form
			className="space-y-1 px-1"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<input
				// biome-ignore lint/a11y/noAutofocus: champ ouvert a la demande
				autoFocus
				type="email"
				value={value}
				onChange={(e) => setValue(e.currentTarget.value)}
				onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
				placeholder="adresse@ss2i-digital.fr"
				className={`w-full rounded-md border bg-transparent px-2 py-1 text-[12.5px] outline-none ${nouvelle ? "border-k-line focus:border-k-accent" : "focus:border-primary"}`}
			/>
			{error && <p className="text-[11.5px] text-red-600">{error}</p>}
			<div className="flex gap-1">
				<button type="submit" className={`rounded px-2 py-0.5 text-[12px] font-medium ${nouvelle ? "bg-k-accent text-white" : "bg-primary text-primary-foreground"}`}>
					{busy ? "Vérification…" : "Ajouter"}
				</button>
				<button type="button" className={`rounded px-2 py-0.5 text-[12px] ${t.muted}`} onClick={() => setOpen(false)}>
					Annuler
				</button>
			</div>
		</form>
	);
}

/** Fuseau d'affichage et notifications du bureau pour les rappels. */
function Settings({ nouvelle }: { nouvelle: boolean }) {
	const t = theme(nouvelle);
	const { tz } = useAgendaState();
	const [perm, setPerm] = useState<string>("default");
	useEffect(() => {
		setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
	}, []);
	const zones = TIME_ZONES.some((z) => z.value === tz) ? TIME_ZONES : [...TIME_ZONES, { value: tz, label: tz }];
	return (
		<div className="space-y-2">
			<div className={`px-1 ${t.title}`}>Réglages</div>
			<label className="block px-1">
				<span className={`mb-0.5 block text-[11.5px] ${t.muted}`}>Fuseau horaire affiché</span>
				<select
					value={tz}
					onChange={(e) => agendaStore.setTz(e.target.value)}
					className={`w-full rounded-md border bg-transparent px-1.5 py-1 text-[12.5px] ${nouvelle ? "border-k-line text-k-ink" : "border-border"}`}
				>
					{zones.map((z) => (
						<option key={z.value} value={z.value}>
							{z.label}
						</option>
					))}
				</select>
			</label>
			{perm !== "unsupported" && (
				<div className={`flex items-center gap-1.5 px-1 text-[12px] ${t.muted}`}>
					<Bell className="h-3.5 w-3.5 shrink-0" />
					{perm === "granted" ? (
						<span>Rappels aussi en notifications du bureau</span>
					) : perm === "denied" ? (
						<span>Notifications du bureau bloquées par le navigateur</span>
					) : (
						<button type="button" className="underline" onClick={() => void Notification.requestPermission().then(setPerm)}>
							Recevoir les rappels en notification du bureau
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export default function KAgendaNav({ boxes, nouvelle }: { boxes: OutlookCalendarBox[]; nouvelle: boolean }) {
	const t = theme(nouvelle);
	const { sources, extra, loaded } = useAgendaState();
	useEffect(() => {
		agendaStore.init(boxes.map((b) => b.identityPublicId));
	}, [boxes]);
	// Dates et preferences du navigateur seulement (rien de date au rendu serveur).
	if (!loaded) return null;
	const own = sources.filter((s) => s.kind === "own");
	const colleagues = sources.filter((s) => s.kind === "colleague");

	return (
		<nav aria-label="Agenda" className="space-y-5">
			<MiniMonth nouvelle={nouvelle} />
			{own.length > 0 && (
				<div>
					<div className={`mb-1 px-1 ${t.title}`}>Mes agendas</div>
					<div className="space-y-px">
						{own.map((s) => (
							<SourceRow key={s.key} s={s} nouvelle={nouvelle} />
						))}
					</div>
				</div>
			)}
			{boxes.length > 0 && (
				<div>
					<div className={`mb-1 px-1 ${t.title}`}>Collègues</div>
					<div className="space-y-px">
						{colleagues.map((s) => (
							<SourceRow key={s.key} s={s} nouvelle={nouvelle} removable={s.kind === "colleague" && extra.includes(s.owner)} />
						))}
						{!colleagues.length && <p className={`px-1.5 pb-1 text-[11.5px] ${t.muted}`}>Aucun agenda partagé avec vous.</p>}
						<AddColleague nouvelle={nouvelle} />
					</div>
				</div>
			)}
			<ToDo nouvelle={nouvelle} />
			<Upcoming nouvelle={nouvelle} />
			<Settings nouvelle={nouvelle} />
		</nav>
	);
}
