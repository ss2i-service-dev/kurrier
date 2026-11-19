"use client";
// ss2i : assistant de planification du formulaire d'evenement, comme celui d'Outlook. Une ligne
// par personne (vous, les participants, la salle) sur la journee choisie, avec les plages
// occupees lues par Microsoft Graph (getSchedule : statut seulement, jamais l'objet), le
// creneau en cours de saisie par-dessus, sur toutes les lignes. Le cadre se glisse pour
// deplacer le creneau, ses bords pour changer le debut ou la fin ; un clic ailleurs sur la
// frise y place le debut (meme duree), et le glisser continue a partir de la.
// En dessous, les prochains creneaux libres pour tout le monde sur 7 jours.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "@mantine/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
	JOURS_COURTS,
	type BusyBlock,
	freeSlots,
	hhmm,
	minutesNowInParis,
	minutesOf,
	todayInParis,
	weekday,
} from "@common/outlook-calendar";
import { addDays } from "@common/thread-agenda";
import type { Schedule } from "@common/outlook-graph";
import { outlookSchedule } from "@/lib/actions/outlook-calendar";

const FROM = 7 * 60;
const TO = 20 * 60;
const SPAN = TO - FROM;
const LABEL_W = 130;

const STATUS: Record<string, { label: string; cls: string }> = {
	busy: { label: "Occupé", cls: "bg-[#4f8de8]" },
	tentative: {
		label: "Provisoire",
		cls: "bg-[#4f8de8]/50 [background-image:repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,255,255,.5)_4px_6px)]",
	},
	oof: { label: "Absent", cls: "bg-[#8764b8]" },
	workingElsewhere: {
		label: "Travail ailleurs",
		cls: "border border-dashed border-[#4f8de8] bg-transparent",
	},
	unknown: { label: "Inconnu", cls: "bg-gray-400" },
};

export type Person = {
	address: string;
	label: string;
	kind?: "me" | "attendee" | "room";
};

function dayTitle(date: string) {
	const s = `${JOURS_COURTS[weekday(date)]} ${Number(date.slice(8, 10))}/${date.slice(5, 7)}`;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Plages d'un jour, bornees a la frise (minutes depuis 7 h). */
function onDay(busy: BusyBlock[], date: string) {
	const a = `${date}T00:00`;
	const b = `${addDays(date, 1)}T00:00`;
	return busy
		.filter((x) => x.start < b && x.end > a)
		.map((x) => {
			const s = x.start <= a ? 0 : minutesOf(x.start);
			const e = x.end >= b ? 24 * 60 : minutesOf(x.end);
			return { ...x, s: Math.max(FROM, s), e: Math.min(TO, e) };
		})
		.filter((x) => x.e > x.s);
}

export default function SchedulingAssistant({
	identityPublicId,
	tz,
	date,
	startMin,
	endMin,
	allDay,
	people,
	nouvelle,
	onPick,
	onRange,
	ignore,
}: {
	identityPublicId: string;
	tz: string;
	date: string;
	startMin: number;
	endMin: number;
	allDay: boolean;
	/** Le premier est la boite elle-meme. */
	people: Person[];
	nouvelle: boolean;
	onPick: (date: string, startMin: number) => void;
	/** Creneau glisse ou redimensionne sur la frise (minutes depuis minuit). */
	onRange?: (date: string, startMin: number, endMin: number) => void;
	/** Horaire d'origine de l'evenement modifie : ses propres plages ne comptent pas. */
	ignore?: { start: string; end: string };
}) {
	const [data, setData] = useState<Schedule[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const req = useRef(0);
	const addresses = people.slice(1).map((p) => p.address);
	const key = addresses.join(",");
	// Fenetre de 7 jours a partir du jour choisi : la frise et les suggestions.
	const from = `${date}T00:00`;
	const to = `${addDays(date, 7)}T00:00`;

	useEffect(() => {
		const id = ++req.current;
		setLoading(true);
		const t = setTimeout(() => {
			outlookSchedule({ identityPublicId, addresses, from, to, tz })
				.catch((e: unknown) => ({
					ok: false as const,
					error: String((e as Error)?.message ?? e),
				}))
				.then((res) => {
					if (id !== req.current) return;
					setLoading(false);
					if (!res.ok) {
						setError(res.error);
						return;
					}
					setError(null);
					setData(res.schedules);
				});
		}, 250);
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [identityPublicId, key, from, to, tz]);

	const byAddress = useMemo(
		() =>
			new Map(
				(data ?? []).map((s) => [
					s.address,
					ignore
						? {
								...s,
								busy: s.busy.filter(
									(b) => !(b.start === ignore.start && b.end === ignore.end),
								),
							}
						: s,
				]),
			),
		[data, ignore?.start, ignore?.end],
	);
	// La boite elle-meme est toujours la premiere reponse du serveur.
	const scheduleOf = (p: Person) =>
		p.kind === "me" ? [...byAddress.values()][0] : byAddress.get(p.address);
	const duration = allDay ? 60 : Math.max(15, endMin - startMin);
	const suggestions = useMemo(() => {
		if (!data) return [];
		const today = todayInParis(new Date(), tz);
		const nowM = minutesNowInParis(new Date(), tz);
		const notBefore = `${today}T${hhmm(Math.ceil(nowM / 30) * 30)}`;
		return freeSlots(
			[...byAddress.values()].filter((s) => !s.error).map((s) => s.busy),
			Array.from({ length: 7 }, (_, i) => addDays(date, i)),
			duration,
			{ notBefore, max: 6 },
		);
	}, [data, byAddress, date, duration, tz]);

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const line = nouvelle ? "border-k-line" : "border-border";
	const track = nouvelle ? "bg-k-surface-2" : "bg-muted/50";
	const pct = (m: number) => `${((m - FROM) / SPAN) * 100}%`;

	// Glisser le cadre (deplacer) ou ses bords (debut, fin), au quart d'heure.
	const area = useRef<HTMLDivElement>(null);
	// Appui d'un doigt hors du cadre : le saut attend le click (voir down).
	const tapJump = useRef(false);
	const drag = useRef<{
		mode: "move" | "start" | "end";
		offset: number;
		s: number;
		e: number;
	} | null>(null);
	const [dragging, setDragging] = useState(false);
	const minuteAt = (clientX: number) => {
		const r = area.current?.getBoundingClientRect();
		if (!r) return FROM;
		const frac = (clientX - r.left - LABEL_W) / Math.max(1, r.width - LABEL_W);
		return FROM + Math.round((frac * SPAN) / 15) * 15;
	};
	const apply = (s0: number, e0: number) =>
		onRange ? onRange(date, s0, e0) : onPick(date, s0);
	const down = (ev: React.PointerEvent<HTMLDivElement>) => {
		tapJump.current = false;
		if (allDay || ev.button !== 0) return;
		const r = area.current?.getBoundingClientRect();
		if (!r || ev.clientX - r.left < LABEL_W) return;
		const m = minuteAt(ev.clientX);
		const handle = (ev.target as HTMLElement)
			.closest("[data-handle]")
			?.getAttribute("data-handle");
		// Doigt hors du cadre : rien a l'appui, le geste peut etre un defilement de la page.
		// Le creneau y saute au click, que le navigateur n'emet pas apres un defilement.
		if (ev.pointerType !== "mouse" && !handle) {
			tapJump.current = true;
			return;
		}
		ev.preventDefault();
		ev.currentTarget.setPointerCapture(ev.pointerId);
		if (handle === "start" || handle === "end") {
			drag.current = { mode: handle, offset: 0, s: startMin, e: endMin };
		} else if (handle === "move") {
			drag.current = {
				mode: "move",
				offset: m - startMin,
				s: startMin,
				e: endMin,
			};
		} else {
			// Clic hors du cadre : le creneau y saute, puis suit le pointeur.
			const s0 = Math.max(FROM, Math.min(m, TO - duration));
			apply(s0, s0 + duration);
			drag.current = { mode: "move", offset: 0, s: s0, e: s0 + duration };
		}
		setDragging(true);
	};
	const move = (ev: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		const m = minuteAt(ev.clientX);
		let s0 = d.s;
		let e0 = d.e;
		if (d.mode === "move") {
			const len = d.e - d.s;
			s0 = Math.max(FROM, Math.min(m - d.offset, TO - len));
			e0 = s0 + len;
		} else if (d.mode === "start") s0 = Math.max(FROM, Math.min(m, d.e - 15));
		else e0 = Math.min(TO, Math.max(m, d.s + 15));
		if (s0 !== startMin || e0 !== endMin) apply(s0, e0);
	};
	const tap = (ev: React.MouseEvent<HTMLDivElement>) => {
		if (!tapJump.current) return;
		tapJump.current = false;
		const m = minuteAt(ev.clientX);
		const s0 = Math.max(FROM, Math.min(m, TO - duration));
		apply(s0, s0 + duration);
	};
	const up = () => {
		drag.current = null;
		setDragging(false);
	};

	const conflicts = people.filter((p) => {
		const s = scheduleOf(p);
		if (!s || allDay) return false;
		const a = `${date}T${hhmm(startMin)}`;
		const b = `${date}T${hhmm(endMin)}`;
		return s.busy.some(
			(x) =>
				x.status !== "free" &&
				x.status !== "workingElsewhere" &&
				x.start < b &&
				x.end > a,
		);
	});

	return (
		<div className={`space-y-2 rounded-md border p-2 ${line}`}>
			<div className="flex items-center gap-1">
				<button
					type="button"
					aria-label="Jour précédent"
					className={`rounded p-0.5 ${muted} hover:bg-black/5`}
					onClick={() => onPick(addDays(date, -1), startMin)}
				>
					<ChevronLeft className="h-4 w-4" />
				</button>
				<span className="min-w-[90px] text-center text-[12.5px] font-medium">
					{dayTitle(date)}
				</span>
				<button
					type="button"
					aria-label="Jour suivant"
					className={`rounded p-0.5 ${muted} hover:bg-black/5`}
					onClick={() => onPick(addDays(date, 1), startMin)}
				>
					<ChevronRight className="h-4 w-4" />
				</button>
				{loading && <Loader size={12} className="ml-1" />}
				<span
					className={`ml-auto text-[11.5px] ${conflicts.length ? "text-amber-700" : muted}`}
				>
					{allDay
						? "Journée entière"
						: conflicts.length
							? `Conflit : ${conflicts.map((p) => p.label).join(", ")}`
							: data
								? "Tout le monde est libre"
								: ""}
				</span>
			</div>

			{error && <div className="text-[12px] text-red-700">{error}</div>}

			<div className="space-y-1">
				<div className="flex text-[10px]">
					<div className="shrink-0" style={{ width: LABEL_W }} />
					<div className={`relative h-3 flex-1 ${muted}`}>
						{Array.from({ length: SPAN / 60 + 1 }, (_, i) => FROM / 60 + i).map(
							(h) => (
								<span
									key={h}
									className="absolute -translate-x-1/2"
									style={{ left: pct(h * 60) }}
								>
									{h}
								</span>
							),
						)}
					</div>
				</div>
				<div
					ref={area}
					className={`relative space-y-1 ${dragging ? "cursor-grabbing select-none" : ""}`}
					onPointerDown={down}
					onPointerMove={move}
					onPointerUp={up}
					onPointerCancel={up}
					onClick={tap}
				>
					{people.map((p) => {
						const s = scheduleOf(p);
						return (
							<div
								key={p.address || "me"}
								className="flex items-center text-[12px]"
							>
								<div
									className="shrink-0 truncate pr-2"
									style={{ width: LABEL_W }}
									title={p.address}
								>
									{p.label}
								</div>
								<div
									className={`relative h-6 flex-1 cursor-pointer overflow-hidden rounded ${track}`}
								>
									{Array.from(
										{ length: SPAN / 60 - 1 },
										(_, i) => FROM + (i + 1) * 60,
									).map((m) => (
										<span
											key={m}
											className={`absolute inset-y-0 border-l ${line}`}
											style={{ left: pct(m) }}
										/>
									))}
									{s?.error ? (
										<span
											className={`absolute inset-0 flex items-center px-1.5 text-[10.5px] ${muted}`}
										>
											{s.error}
										</span>
									) : (
										onDay(s?.busy ?? [], date).map((b, i) => (
											<span
												key={i}
												title={`${STATUS[b.status ?? "busy"]?.label ?? "Occupé"} ${b.start.slice(11, 16)} – ${b.end.slice(11, 16)}`}
												className={`absolute inset-y-0.5 rounded-sm ${STATUS[b.status ?? "busy"]?.cls ?? STATUS.busy.cls}`}
												style={{
													left: pct(b.s),
													width: `${((b.e - b.s) / SPAN) * 100}%`,
												}}
											/>
										))
									)}
								</div>
							</div>
						);
					})}
					{!allDay && (
						<div
							data-handle="move"
							title={`${hhmm(startMin)} – ${hhmm(endMin)}`}
							className={`absolute inset-y-[-2px] z-10 cursor-grab touch-none rounded-sm border-2 ${dragging ? "cursor-grabbing" : ""} ${nouvelle ? "border-k-accent bg-k-accent/15" : "border-primary bg-primary/15"}`}
							style={{
								left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${(Math.max(FROM, startMin) - FROM) / SPAN})`,
								width: `calc((100% - ${LABEL_W}px) * ${(Math.min(TO, endMin) - Math.max(FROM, startMin)) / SPAN})`,
							}}
						>
							<span
								data-handle="start"
								className="absolute inset-y-0 -left-1 w-2.5 cursor-ew-resize"
							/>
							<span
								data-handle="end"
								className="absolute inset-y-0 -right-1 w-2.5 cursor-ew-resize"
							/>
							<span
								className={`pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded px-1 text-[10.5px] font-medium ${nouvelle ? "bg-k-accent text-white" : "bg-primary text-primary-foreground"} ${dragging ? "" : "hidden"}`}
							>
								{hhmm(startMin)} – {hhmm(endMin)}
							</span>
						</div>
					)}
				</div>
			</div>

			{suggestions.length > 0 && (
				<div className={`border-t pt-2 ${line}`}>
					<div className={`mb-1 text-[11.5px] ${muted}`}>
						Créneaux libres pour tout le monde ({duration} min)
					</div>
					<div className="flex flex-wrap gap-1.5">
						{suggestions.map((x) => (
							<button
								type="button"
								key={x.start}
								onClick={() => onPick(x.start.slice(0, 10), minutesOf(x.start))}
								className={`rounded-full border px-2 py-0.5 text-[11.5px] hover:bg-black/5 ${line}`}
							>
								{dayTitle(x.start.slice(0, 10))} {x.start.slice(11, 16)}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
