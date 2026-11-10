"use client";
// ss2i : creation et modification d'un evenement Outlook depuis courrier, comme dans Outlook :
// titre, horaire ou journee entiere et son fuseau, repetition, participants (suggestions des
// destinataires habituels, invitations et mises a jour envoyees par Microsoft) avec
// l'assistant de planification (disponibilites et creneaux libres pour tous), salle de
// reunion (avec sa disponibilite), reunion Teams et ses options, lieu, agenda, categories,
// disponibilite, prive, rappel, propositions d'horaire, notes, pieces jointes. Une occurrence
// de serie se modifie seule ou avec toute la serie. Tout est ecrit par Microsoft Graph.
// Copie locale (lib/form-backup.ts, Samuel le 10/11 : « on est en 2026 ») : tout l'etat saisi
// est ecrit dans localStorage a chaque modification et repropose a la reouverture du meme
// formulaire (creation : une copie par boite, modification : une par evenement). Elle ne part
// que quand Graph a accepte l'enregistrement ou sur « Annuler » ; fermer par erreur (clic
// dehors, Echap, croix) la garde. Les fichiers joints ne sont pas gardes (pas de copie binaire).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Modal, NativeSelect, SegmentedControl, Select, Switch, TagsInput, TextInput, Textarea } from "@mantine/core";
import { CalendarSearch, Paperclip, Settings2, X } from "lucide-react";
import { toast } from "sonner";
import { AGENDA_TIMEZONE, addDays } from "@common/thread-agenda";
import { TIME_ZONES, hhmm, minutesOf } from "@common/outlook-calendar";
import {
	ATTACHMENT_MAX_BYTES,
	type Attendee,
	type EventAttachment,
	type EventDetail,
	type EventInput,
	type EventScope,
	type OutlookCategory,
	RECURRENCES,
	REMINDERS,
	type Room,
	SHOW_AS,
} from "@common/outlook-graph";
import {
	type CalendarSource,
	type SourceRef,
	createOutlookCategory,
	outlookRooms,
	outlookSchedule,
	saveOutlookEvent,
} from "@/lib/actions/outlook-calendar";
import { suggestRecipients } from "@/lib/actions/recipient-suggestions";
import { agendaEditKey, agendaNewKey, removeFormBackup, restorableBackup, syncFormBackup } from "@/lib/form-backup";
import SchedulingAssistant from "@/components/outlook-calendar/scheduling-assistant";
import TeamsOptionsModal from "@/components/outlook-calendar/teams-options";

export type EditorTarget = {
	/** Absent : creation. */
	id?: string;
	source: SourceRef;
	sourceKey: string;
	seriesMasterId?: string;
	isSeries?: boolean;
	initial: EventInput;
	/** Corps HTML existant (garde tel quel si les notes ne changent pas). */
	hadBody?: boolean;
	attachments?: EventAttachment[];
	/** Je l'organise (options Teams). */
	isOrganizer?: boolean;
};

/** Saisie du formulaire a partir d'un evenement existant. */
export function inputFromDetail(e: EventDetail): EventInput {
	const div = typeof document !== "undefined" ? document.createElement("div") : null;
	if (div) div.innerHTML = e.bodyHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
	const notes = (div?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
	return {
		title: e.title,
		allDay: e.allDay,
		start: e.start,
		end: e.end,
		location: e.room ? undefined : e.location,
		notes,
		attendees: e.attendees.filter((a) => a.address !== e.organizerAddress && a.address !== e.room?.address).map(({ proposed: _p, ...a }) => a),
		online: e.isOnlineMeeting,
		showAs: (e.showAs as EventInput["showAs"]) ?? "busy",
		isPrivate: e.isPrivate,
		reminderMinutes: e.reminderMinutes,
		recurrence: e.recurrence,
		recurrenceUntil: e.recurrenceUntil,
		timeZone: e.timeZone,
		categories: e.categories,
		room: e.room,
		allowNewTimeProposals: e.allowNewTimeProposals,
	};
}

/** Saisie vierge sur un creneau (minutes = null : journee entiere). */
export function blankInput(date: string, minutes: number | null, endMinutes?: number, tz?: string): EventInput {
	const allDay = minutes === null;
	const s = minutes ?? 9 * 60;
	const e = Math.min(endMinutes ?? s + 30, 23 * 60 + 59);
	return {
		title: "",
		allDay,
		start: allDay ? date : `${date}T${hhmm(s)}`,
		end: allDay ? date : `${date}T${hhmm(e)}`,
		attendees: [],
		online: false,
		showAs: allDay ? "free" : "busy",
		isPrivate: false,
		// 10 minutes avant par defaut (le bandeau de reunion apparait a l'heure du rappel)
		reminderMinutes: allDay ? null : 10,
		recurrence: "none",
		timeZone: tz,
		categories: [],
		allowNewTimeProposals: true,
	};
}

/** Etat saisi qui se compare a la copie locale (la cible et la boite s'y ajoutent pour rouvrir l'editeur apres un rechargement). */
type EditorValues = { v: EventInput; sourceKey: string; scope: EventScope; removed: string[] };

const isEditorValues = (x: any): x is EditorValues =>
	!!x && typeof x.v?.title === "string" && typeof x.v?.start === "string" && typeof x.v?.end === "string" && Array.isArray(x.v?.attendees) && Array.isArray(x.removed);

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Durees proposees ; une duree saisie a la main (champ Fin) s'ajoute a la liste. */
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];
const durationLabel = (m: number) => {
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	const r = m % 60;
	return r ? `${h} h ${String(r).padStart(2, "0")}` : `${h} h`;
};
function durationOptions(current: number) {
	const list = DURATIONS.includes(current) || current <= 0 ? DURATIONS : [...DURATIONS, current].sort((a, b) => a - b);
	return list.map((m) => ({ value: String(m), label: durationLabel(m) }));
}

const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

function fileToBase64(f: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result ?? "").replace(/^data:[^,]*,/, ""));
		r.onerror = () => reject(r.error ?? new Error("Lecture du fichier impossible"));
		r.readAsDataURL(f);
	});
}

export default function EventEditor({
	target,
	identityPublicId,
	sources,
	nouvelle,
	tz = AGENDA_TIMEZONE,
	categories = [],
	onCategoryCreated,
	onClose,
	onSaved,
}: {
	target: EditorTarget | null;
	identityPublicId: string;
	sources: CalendarSource[];
	nouvelle: boolean;
	/** Fuseau d'affichage (celui des heures de target.initial). */
	tz?: string;
	categories?: OutlookCategory[];
	onCategoryCreated?: (c: OutlookCategory) => void;
	onClose: () => void;
	onSaved: (message: string) => void;
}) {
	const [v, setV] = useState<EventInput | null>(null);
	const [sourceKey, setSourceKey] = useState("");
	const [scope, setScope] = useState<EventScope>("occurrence");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [suggest, setSuggest] = useState<{ value: string; label: string }[]>([]);
	const [query, setQuery] = useState("");
	const [assistant, setAssistant] = useState(false);
	const [rooms, setRooms] = useState<Room[] | null>(null);
	const [roomError, setRoomError] = useState<string | null>(null);
	const [roomBusy, setRoomBusy] = useState<Record<string, boolean>>({});
	const [files, setFiles] = useState<File[]>([]);
	const [removed, setRemoved] = useState<string[]>([]);
	const [teamsOpen, setTeamsOpen] = useState(false);
	// Cle et etat initial de la copie locale du formulaire ouvert (poses avec v, dans le meme rendu).
	const [backup, setBackup] = useState<{ key: string; initial: EditorValues } | null>(null);
	// Copie retiree (enregistre, annule, « Effacer ») : plus rien ne la reecrit.
	const discarded = useRef<string | null>(null);
	const busy = useRef(false);
	const fileInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!target) return;
		const base: EventInput = { categories: [], allowNewTimeProposals: true, ...target.initial, timeZone: target.initial.timeZone ?? tz, notesChanged: false };
		const initialScope: EventScope = target.isSeries ? "series" : "occurrence";
		const initial: EditorValues = { v: base, sourceKey: target.sourceKey, scope: initialScope, removed: [] };
		const key = target.id ? agendaEditKey(target.id) : agendaNewKey(identityPublicId);
		const copy = restorableBackup(key, initial);
		const saved = copy && isEditorValues(copy.values) ? copy.values : null;
		discarded.current = null;
		setBackup({ key, initial });
		// Pas de fusion avec base : un champ vide (undefined) a la sauvegarde ne doit pas reprendre sa valeur d'origine.
		setV(saved ? saved.v : base);
		setSourceKey(saved?.sourceKey ?? target.sourceKey);
		setScope(saved?.scope ?? initialScope);
		setError(null);
		setSaving(false);
		setFiles([]);
		setRemoved(saved?.removed ?? []);
		setAssistant(true);
		if (!saved) return;
		toast("Saisie restaurée depuis ce navigateur", {
			id: `form-backup:${key}`,
			position: nouvelle ? "bottom-center" : "bottom-left",
			duration: 12000,
			action: {
				label: "Effacer",
				onClick: () => {
					discarded.current = key;
					removeFormBackup(key);
					setV(base);
					setSourceKey(target.sourceKey);
					setScope(initialScope);
					setRemoved([]);
				},
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target, tz]);

	// Copie locale a chaque modification d'un champ ; retiree si la saisie revient a l'etat initial.
	useEffect(() => {
		if (!target || !v || !backup || discarded.current === backup.key) return;
		syncFormBackup(backup.key, { v, sourceKey, scope, removed, identityPublicId, target }, backup.initial);
	}, [v, sourceKey, scope, removed, backup]); // eslint-disable-line react-hooks/exhaustive-deps

	// « Annuler » : abandon voulu, la copie part avec. Fermer sans ce bouton la garde.
	const cancel = () => {
		if (backup) {
			discarded.current = backup.key;
			removeFormBackup(backup.key);
		}
		onClose();
	};

	// Suggestions de participants : destinataires habituels (meme moteur que l'editeur de mail).
	useEffect(() => {
		if (!v) return;
		const q = query.trim();
		let alive = true;
		const t = setTimeout(() => {
			suggestRecipients({ query: q, current: v.attendees.map((a) => a.address) })
				.then((list) => {
					if (!alive) return;
					setSuggest(list.slice(0, 8).map((c) => ({ value: c.email, label: c.name && c.name !== c.email ? `${c.name} <${c.email}>` : c.email })));
				})
				.catch(() => {});
		}, 150);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [query, v?.attendees.length]);

	// Disponibilite des salles sur le creneau saisi.
	const slotKey = v && !v.allDay ? `${v.start}|${v.end}|${v.timeZone}` : "";
	useEffect(() => {
		if (!rooms?.length || !v || v.allDay) {
			setRoomBusy({});
			return;
		}
		let alive = true;
		const t = setTimeout(() => {
			outlookSchedule({ identityPublicId, addresses: rooms.map((r) => r.address), from: v.start, to: v.end, tz: v.timeZone })
				.then((res) => {
					if (!alive || !res.ok) return;
					const ignore = target?.initial;
					const map: Record<string, boolean> = {};
					for (const s of res.schedules) {
						if (s.error) continue;
						map[s.address] = s.busy.some((b) => b.status !== "free" && !(ignore && b.start === ignore.start && b.end === ignore.end && s.address === ignore.room?.address));
					}
					setRoomBusy(map);
				})
				.catch(() => {});
		}, 300);
		return () => {
			alive = false;
			clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rooms, slotKey, identityPublicId]);

	const catColor = useMemo(() => new Map(categories.map((c) => [c.name, c.color])), [categories]);

	if (!target || !v) return null;
	const editing = !!target.id;
	const writable = sources.filter((s) => s.editable);
	const source = sources.find((s) => s.key === sourceKey) ?? sources.find((s) => s.key === target.sourceKey);
	const set = (patch: Partial<EventInput>) => setV((cur) => (cur ? { ...cur, ...patch } : cur));
	const date = v.start.slice(0, 10);
	const endDate = v.end.slice(0, 10);
	const occurrence = editing && !!target.seriesMasterId;
	const own = source?.kind !== "colleague";
	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const line = nouvelle ? "border-k-line" : "border-border";

	const setStartDate = (d: string) => {
		if (v.allDay) {
			const span = Math.max(0, Math.round((Date.parse(endDate) - Date.parse(date)) / 86_400_000));
			set({ start: d, end: addDays(d, span) });
		} else set({ start: `${d}T${v.start.slice(11, 16)}`, end: `${d}T${v.end.slice(11, 16)}` });
	};
	const setStartTime = (time: string) => {
		// La duree suit l'heure de debut (comme Outlook).
		const len = Math.max(15, minutesOf(v.end) - minutesOf(v.start));
		const s = minutesOf(`${date}T${time}`);
		set({ start: `${date}T${time}`, end: `${date}T${hhmm(Math.min(s + len, 23 * 60 + 59))}` });
	};
	const pickSlot = (d: string, m: number) => {
		if (v.allDay) {
			setStartDate(d);
			return;
		}
		const len = Math.max(15, minutesOf(v.end) - minutesOf(v.start));
		set({ start: `${d}T${hhmm(m)}`, end: `${d}T${hhmm(Math.min(m + len, 23 * 60 + 59))}` });
	};
	// Duree choisie : la fin suit le debut (bornee a 23 h 59, comme le champ heure).
	const setDuration = (len: number) => {
		if (!Number.isFinite(len) || len <= 0) return;
		set({ end: `${date}T${hhmm(Math.min(minutesOf(v.start) + len, 23 * 60 + 59))}` });
	};
	const toggleAllDay = (allDay: boolean) =>
		set(
			allDay
				? { allDay, start: date, end: date, showAs: "free", reminderMinutes: null }
				: { allDay, start: `${date}T09:00`, end: `${date}T09:30`, showAs: "busy", reminderMinutes: 10 },
		);

	const setAttendees = (list: string[]) => {
		const out: Attendee[] = [];
		for (const raw of list) {
			const m = /<([^>]+)>/.exec(raw);
			const address = (m ? m[1] : raw).trim().toLowerCase();
			if (!EMAIL_RE.test(address) || out.some((a) => a.address === address)) continue;
			const prev = v.attendees.find((a) => a.address === address);
			out.push(prev ?? { address, type: "required" });
		}
		set({ attendees: out });
	};

	const loadRooms = () => {
		if (rooms || roomError) return;
		outlookRooms({ identityPublicId })
			.then((res) => (res.ok ? setRooms(res.rooms) : setRoomError(res.error)))
			.catch((e: unknown) => setRoomError(String((e as Error)?.message ?? e)));
	};

	const setCategories = async (names: string[]) => {
		const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
		set({ categories: clean });
		// Categorie inconnue : creee dans la liste principale d'Outlook.
		for (const n of clean) {
			if (categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) continue;
			const res = await createOutlookCategory({ identityPublicId, name: n }).catch(() => null);
			if (res?.ok) onCategoryCreated?.(res.category);
			else if (res && !res.ok) setError(res.error);
		}
	};

	const addFiles = (list: FileList | null) => {
		if (!list) return;
		const next = [...files];
		for (const f of Array.from(list)) {
			if (f.size > ATTACHMENT_MAX_BYTES) {
				setError(`${f.name} dépasse 25 Mo.`);
				continue;
			}
			next.push(f);
		}
		setFiles(next);
	};

	const submit = async () => {
		if (busy.current) return;
		if (!v.title.trim()) {
			setError("Donnez un titre à l'événement.");
			return;
		}
		if (!source) {
			setError("Choisissez un agenda.");
			return;
		}
		busy.current = true;
		setSaving(true);
		setError(null);
		const ref: SourceRef = source.kind === "own" ? { kind: "own", calendarId: source.calendarId } : { kind: "colleague", owner: source.owner };
		const attachments = await Promise.all(files.map(async (f) => ({ name: f.name, contentType: f.type || "application/octet-stream", base64: await fileToBase64(f) }))).catch(
			(e: unknown) => {
				setError(String((e as Error)?.message ?? e));
				return null;
			},
		);
		if (!attachments) {
			busy.current = false;
			setSaving(false);
			return;
		}
		const res = await saveOutlookEvent({
			identityPublicId,
			source: editing ? target.source : ref,
			id: target.id,
			event: v,
			scope,
			seriesMasterId: target.seriesMasterId,
			attachments,
			removeAttachmentIds: removed,
		}).catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
		busy.current = false;
		setSaving(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		// Graph a accepte : la copie locale n'a plus d'objet.
		if (backup) {
			discarded.current = backup.key;
			removeFormBackup(backup.key);
		}
		const invited = v.attendees.length > 0 || !!v.room;
		onSaved(editing ? (invited ? "Événement modifié, participants prévenus" : "Événement modifié") : invited ? "Invitation envoyée" : "Événement ajouté");
	};

	const people = [
		{ address: "", label: "Vous", kind: "me" as const },
		...v.attendees.map((a) => ({ address: a.address, label: a.name ?? a.address, kind: "attendee" as const })),
		...(v.room ? [{ address: v.room.address, label: v.room.name, kind: "room" as const }] : []),
	];
	const existing = (target.attachments ?? []).filter((a) => !removed.includes(a.id) && !a.isInline);
	const roomOptions = (rooms ?? []).map((r) => ({
		value: r.address,
		label: `${r.name}${r.capacity ? ` · ${r.capacity} pers.` : ""}${r.building ? ` · ${r.building}` : ""}${r.address in roomBusy ? (roomBusy[r.address] ? " · occupée" : " · libre") : ""}`,
	}));
	if (v.room && !roomOptions.some((o) => o.value === v.room?.address)) roomOptions.unshift({ value: v.room.address, label: v.room.name });
	const zones = TIME_ZONES.some((z) => z.value === v.timeZone) ? TIME_ZONES : [...TIME_ZONES, { value: v.timeZone ?? tz, label: v.timeZone ?? tz }];

	return (
		<Modal
			opened
			onClose={onClose}
			title={editing ? "Modifier l'événement" : "Nouvel événement"}
			size="100%"
			styles={{ content: { maxWidth: 1240, marginInline: "auto" }, body: { paddingBottom: 12 } }}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<div className="grid gap-x-6 gap-y-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
					<div className="space-y-3">
						<TextInput
							placeholder="Ajouter un titre"
							aria-label="Titre"
							size="md"
							data-autofocus
							autoFocus={!editing}
							value={v.title}
							maxLength={255}
							onChange={(e) => set({ title: e.currentTarget.value })}
						/>

						{occurrence && (
							<SegmentedControl
								size="sm"
								value={scope}
								onChange={(x) => setScope(x as EventScope)}
								data={[
									{ value: "occurrence", label: "Cette occurrence" },
									{ value: "series", label: "Toute la série" },
								]}
							/>
						)}

						<div className="flex flex-wrap items-end gap-2">
							<TextInput size="sm" type="date" label="Date" value={date} onChange={(e) => e.currentTarget.value && setStartDate(e.currentTarget.value)} disabled={occurrence && scope === "series"} />
							{v.allDay ? (
								<TextInput
									size="sm"
									type="date"
									label="Fin (incluse)"
									value={endDate}
									min={date}
									onChange={(e) => e.currentTarget.value && set({ end: e.currentTarget.value < date ? date : e.currentTarget.value })}
								/>
							) : (
								<>
									<TextInput size="sm" type="time" label="Début" value={v.start.slice(11, 16)} onChange={(e) => e.currentTarget.value && setStartTime(e.currentTarget.value)} />
									<TextInput size="sm" type="time" label="Fin" value={v.end.slice(11, 16)} onChange={(e) => e.currentTarget.value && set({ end: `${date}T${e.currentTarget.value}` })} />
									<NativeSelect
										size="sm"
										label="Durée"
										value={String(Math.max(0, minutesOf(v.end) - minutesOf(v.start)))}
										onChange={(e) => setDuration(Number(e.currentTarget.value))}
										data={durationOptions(Math.max(0, minutesOf(v.end) - minutesOf(v.start)))}
									/>
									<NativeSelect
										size="sm"
										label="Fuseau"
										className="max-w-[190px]"
										value={v.timeZone ?? tz}
										onChange={(e) => set({ timeZone: e.currentTarget.value })}
										data={zones}
									/>
								</>
							)}
							<Checkbox size="sm" className="pb-1.5" label="Journée entière" checked={v.allDay} onChange={(e) => toggleAllDay(e.currentTarget.checked)} />
						</div>
						{!v.allDay && (v.timeZone ?? tz) !== tz && (
							<div className={`-mt-1 text-[12.5px] ${muted}`}>Heures saisies dans ce fuseau ; l'agenda les affiche dans le vôtre.</div>
						)}

						{(!occurrence || scope === "series") && (
							<div className="flex flex-wrap items-end gap-2">
								{v.recurrence === "custom" ? (
									<div className={`text-xs ${muted}`}>Répétition personnalisée définie dans Outlook (non modifiable ici).</div>
								) : (
									<>
										<NativeSelect
											size="sm"
											label="Répétition"
											value={v.recurrence}
											onChange={(e) => set({ recurrence: e.currentTarget.value as EventInput["recurrence"] })}
											data={RECURRENCES}
										/>
										{v.recurrence !== "none" && (
											<TextInput
												size="sm"
												type="date"
												label="Jusqu'au (facultatif)"
												min={date}
												value={v.recurrenceUntil ?? ""}
												onChange={(e) => set({ recurrenceUntil: e.currentTarget.value || undefined })}
											/>
										)}
									</>
								)}
							</div>
						)}
						<div className="flex flex-wrap items-center gap-3">
							<Switch
								size="sm"
								label="Réunion Teams"
								checked={v.online}
								disabled={editing && target.initial.online}
								description={editing && target.initial.online ? "Le lien Teams se retire depuis Outlook." : undefined}
								onChange={(e) => set({ online: e.currentTarget.checked })}
							/>
							{editing && target.initial.online && target.isOrganizer && own && (
								<Button size="compact-sm" variant="subtle" leftSection={<Settings2 size={12} />} onClick={() => setTeamsOpen(true)}>
									Options de la réunion
								</Button>
							)}
						</div>

						{!v.room && <TextInput size="sm" placeholder="Lieu" aria-label="Lieu" value={v.location ?? ""} onChange={(e) => set({ location: e.currentTarget.value })} />}
						{v.room && (
							<TextInput size="sm" placeholder="Autre lieu (facultatif)" aria-label="Autre lieu" value={v.location ?? ""} onChange={(e) => set({ location: e.currentTarget.value })} />
						)}

						<div className="flex flex-wrap items-end gap-2">
							{!editing && writable.length > 1 && (
								<NativeSelect
									size="sm"
									label="Agenda"
									value={sourceKey}
									onChange={(e) => setSourceKey(e.currentTarget.value)}
									data={writable.map((s) => ({ value: s.key, label: s.kind === "colleague" ? `${s.name} (collègue)` : s.name }))}
								/>
							)}
							<NativeSelect size="sm" label="Afficher comme" value={v.showAs} onChange={(e) => set({ showAs: e.currentTarget.value as EventInput["showAs"] })} data={SHOW_AS} />
							<NativeSelect
								size="sm"
								label="Rappel"
								value={v.reminderMinutes === null ? "none" : String(v.reminderMinutes)}
								onChange={(e) => set({ reminderMinutes: e.currentTarget.value === "none" ? null : Number(e.currentTarget.value) })}
								data={REMINDERS.some((r) => r.value === String(v.reminderMinutes)) || v.reminderMinutes === null ? REMINDERS : [...REMINDERS, { value: String(v.reminderMinutes), label: `${v.reminderMinutes} minutes avant` }]}
							/>
							<Checkbox size="sm" className="pb-1.5" label="Privé" checked={v.isPrivate} onChange={(e) => set({ isPrivate: e.currentTarget.checked })} />
						</div>

						{own && (
							<TagsInput
								size="sm"
								label="Catégories"
								placeholder={v.categories?.length ? "" : "Choisir ou créer une catégorie"}
								value={v.categories ?? []}
								onChange={(x) => void setCategories(x)}
								data={categories.map((c) => c.name)}
								comboboxProps={{ zIndex: 400 }}
								renderOption={({ option }) => (
									<span className="flex items-center gap-2">
										<span className="h-2.5 w-2.5 rounded-sm" style={{ background: catColor.get(option.value) ?? "#9aa0a6" }} />
										{option.value}
									</span>
								)}
								clearable
							/>
						)}

						{v.attendees.length > 0 && (
							<Checkbox
								size="sm"
								label="Les participants peuvent proposer un autre horaire"
								checked={v.allowNewTimeProposals !== false}
								onChange={(e) => set({ allowNewTimeProposals: e.currentTarget.checked })}
							/>
						)}

						<Textarea
							size="sm"
							label="Notes"
							autosize
							minRows={3}
							maxRows={10}
							value={v.notes ?? ""}
							onChange={(e) => set({ notes: e.currentTarget.value, notesChanged: true })}
							description={editing && target.hadBody && !v.notesChanged ? "La mise en forme d'Outlook est gardée tant que les notes ne sont pas modifiées." : undefined}
						/>

						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<Button size="compact-sm" variant="default" leftSection={<Paperclip size={12} />} onClick={() => fileInput.current?.click()}>
									Joindre des fichiers
								</Button>
								<input
									ref={fileInput}
									type="file"
									multiple
									hidden
									onChange={(e) => {
										addFiles(e.currentTarget.files);
										e.currentTarget.value = "";
									}}
								/>
								<span className={`text-[11px] ${muted}`}>25 Mo au plus par fichier</span>
							</div>
							{(existing.length > 0 || files.length > 0) && (
								<div className={`flex flex-wrap gap-1.5 rounded-md border p-1.5 ${line}`}>
									{existing.map((a) => (
										<span key={a.id} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12.5px] ${line}`}>
											<Paperclip className="h-3 w-3" />
											<span className="max-w-[200px] truncate">{a.name}</span>
											<span className={muted}>{sizeLabel(a.size)}</span>
											<button type="button" aria-label={`Retirer ${a.name}`} onClick={() => setRemoved([...removed, a.id])} className="rounded hover:bg-black/5">
												<X className="h-3 w-3" />
											</button>
										</span>
									))}
									{files.map((f, i) => (
										<span key={`${f.name}-${i}`} className={`flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-[12.5px] ${line}`}>
											<Paperclip className="h-3 w-3" />
											<span className="max-w-[200px] truncate">{f.name}</span>
											<span className={muted}>{sizeLabel(f.size)}</span>
											<button type="button" aria-label={`Retirer ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="rounded hover:bg-black/5">
												<X className="h-3 w-3" />
											</button>
										</span>
									))}
								</div>
							)}
						</div>
					</div>
					<div className={`space-y-3 lg:border-l lg:pl-6 ${line}`}>
						<div className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${muted}`}>Participants et disponibilités</div>
						<TagsInput
							size="sm"
							label="Participants"
							placeholder={v.attendees.length ? "" : "Adresses e-mail (Entrée pour valider)"}
							value={v.attendees.map((a) => a.address)}
							onChange={setAttendees}
							data={suggest.filter((s) => !v.attendees.some((a) => a.address === s.value))}
							searchValue={query}
							onSearchChange={setQuery}
							splitChars={[",", ";", " "]}
							clearable
							acceptValueOnBlur
						/>
						{v.attendees.length > 0 && (
							<div className="flex flex-wrap gap-x-3 gap-y-1">
								{v.attendees.map((a) => (
									<label key={a.address} className={`flex items-center gap-1 text-[12.5px] ${muted}`}>
										<span className="max-w-[180px] truncate">{a.address}</span>
										<select
											className="rounded border bg-transparent px-1 text-[11px]"
											value={a.type}
											onChange={(e) => set({ attendees: v.attendees.map((x) => (x.address === a.address ? { ...x, type: e.target.value as Attendee["type"] } : x)) })}
										>
											<option value="required">obligatoire</option>
											<option value="optional">facultatif</option>
											<option value="resource">ressource</option>
										</select>
									</label>
								))}
							</div>
						)}

						<div className="flex flex-wrap items-end gap-2">
							<Select
								size="sm"
								label="Salle"
								placeholder={roomError ? "Salles indisponibles" : "Réserver une salle"}
								className="min-w-[220px] flex-1"
								searchable
								clearable
								nothingFoundMessage={rooms ? "Aucune salle" : "Chargement…"}
								onDropdownOpen={loadRooms}
								data={roomOptions}
								value={v.room?.address ?? null}
								onChange={(address) => {
									const r = (rooms ?? []).find((x) => x.address === address);
									set({ room: r ? { address: r.address, name: r.name } : undefined });
								}}
								comboboxProps={{ zIndex: 400 }}
							/>
							<Button
								size="sm"
								variant="default"
								leftSection={<CalendarSearch size={14} />}
								onClick={() => {
									setAssistant(!assistant);
									loadRooms();
								}}
							>
								{assistant ? "Masquer les disponibilités" : "Disponibilités"}
							</Button>
						</div>
						{roomError && <div className={`-mt-1 text-[12.5px] ${muted}`}>{roomError}</div>}
						{v.room && roomBusy[v.room.address] && <div className="-mt-1 text-[12.5px] text-amber-700">Cette salle est déjà occupée sur ce créneau.</div>}

						{assistant && (
							<SchedulingAssistant
								identityPublicId={identityPublicId}
								tz={v.timeZone ?? tz}
								date={date}
								startMin={v.allDay ? 0 : minutesOf(v.start)}
								endMin={v.allDay ? 24 * 60 : minutesOf(v.end)}
								allDay={v.allDay}
								people={people}
								nouvelle={nouvelle}
								onPick={pickSlot}
						onRange={(d, a, b) => set({ start: `${d}T${hhmm(a)}`, end: `${d}T${hhmm(Math.min(b, 23 * 60 + 59))}` })}
								ignore={editing && !target.initial.allDay ? { start: target.initial.start, end: target.initial.end } : undefined}
							/>
						)}
					</div>
				</div>
				<div className={`mt-4 space-y-2 border-t pt-3 ${line}`}>
				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
						{error}
					</div>
				)}
				<div className="flex items-center justify-end gap-2 pt-1">
					<span className={`mr-auto text-[12.5px] ${muted}`}>Enregistré dans Outlook{source ? ` · ${source.name}` : ""}</span>
					<Button variant="default" size="sm" onClick={cancel}>
						Annuler
					</Button>
					<Button type="submit" size="sm" aria-disabled={saving}>
						{saving ? "Enregistrement…" : editing ? "Enregistrer" : v.attendees.length || v.room ? "Envoyer l'invitation" : "Ajouter"}
					</Button>
				</div>
				</div>
			</form>
			{editing && target.id && (
				<TeamsOptionsModal identityPublicId={identityPublicId} eventId={target.id} opened={teamsOpen} onClose={() => setTeamsOpen(false)} onSaved={(m) => toast.success(m)} />
			)}
		</Modal>
	);
}
