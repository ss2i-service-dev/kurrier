"use client";
// ss2i : detail d'un evenement Outlook, pres de l'evenement clique (Echap ou clic ailleurs
// ferme). Detail relu sur Graph : participants et leurs reponses, lien Teams, repetition,
// notes. Actions comme dans Outlook : repondre a une invitation (accepter, provisoire,
// refuser, avec un mot facultatif), modifier, supprimer (une reunion que j'organise est
// annulee aupres des participants ; une invitation supprimee est refusee), ouvrir dans
// Outlook. Agenda d'un collegue : ce que son partage laisse voir. Aussi : pieces jointes a
// telecharger, categories, salle, proposer un autre horaire (invitation) ou accepter celui
// qu'un participant propose (organisateur), transferer l'invitation, options Teams.
import React, { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Button, Loader, TagsInput, TextInput, Textarea } from "@mantine/core";
import { toast } from "sonner";
import { Building2, Check, CircleHelp, Clock, Copy, ExternalLink, Forward, Lock, MapPin, Paperclip, Pencil, Repeat, Settings2, Trash2, Users, Video, X } from "lucide-react";
import { AGENDA_TIMEZONE, agendaWhen } from "@common/thread-agenda";
import type { CalendarEvent } from "@common/outlook-calendar";
import type { AttendeeResponse, EventDetail, EventScope, InviteResponse, OutlookCategory } from "@common/outlook-graph";
import {
	type CalendarSource,
	type SourceRef,
	deleteOutlookEvent,
	forwardOutlookEvent,
	getOutlookEvent,
	moveOutlookEvent,
	outlookAttachment,
	respondOutlookEvent,
} from "@/lib/actions/outlook-calendar";
import { type EditorTarget, inputFromDetail } from "@/components/outlook-calendar/event-editor";
import TeamsOptionsModal from "@/components/outlook-calendar/teams-options";
import { formatEventForCopy } from "@/lib/event-copy";
import { htmlToText } from "@/lib/mail-copy";

const toMin = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const when = (start: string, end: string) => agendaWhen({ title: "", allDay: false, start, end, sourceQuote: "" });

function download(name: string, contentType: string, base64: string) {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const RESPONSE: Record<AttendeeResponse, { label: string; cls: string }> = {
	accepted: { label: "Accepté", cls: "text-green-600" },
	tentativelyAccepted: { label: "Provisoire", cls: "text-amber-600" },
	declined: { label: "Refusé", cls: "text-red-600" },
	organizer: { label: "Organisateur", cls: "" },
	none: { label: "Pas de réponse", cls: "opacity-60" },
	notResponded: { label: "Pas de réponse", cls: "opacity-60" },
};

const refOf = (s: CalendarSource | undefined): SourceRef =>
	!s ? { kind: "own" } : s.kind === "own" ? { kind: "own", calendarId: s.calendarId } : { kind: "colleague", owner: s.owner };

export default function EventPopover({
	event,
	rect,
	source,
	identityPublicId,
	nouvelle,
	tz = AGENDA_TIMEZONE,
	categories = [],
	onClose,
	onEdit,
	onChanged,
	onPreview,
}: {
	event: CalendarEvent;
	rect: DOMRect;
	source: CalendarSource | undefined;
	identityPublicId: string;
	nouvelle: boolean;
	tz?: string;
	categories?: OutlookCategory[];
	onClose: () => void;
	onEdit: (t: EditorTarget) => void;
	onChanged: (message: string) => void;
	/** Creneaux a montrer en pointilles sur l'agenda (propositions), null pour les retirer. */
	onPreview?: (slots: { start: string; end: string; label: string }[] | null) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [detail, setDetail] = useState<EventDetail | null>(null);
	const [perm, setPerm] = useState<{ editable: boolean; canRespond: boolean }>({ editable: false, canRespond: false });
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [respondWith, setRespondWith] = useState<InviteResponse | null>(null);
	const [comment, setComment] = useState("");
	const [scope, setScope] = useState<EventScope>("occurrence");
	const [propose, setPropose] = useState<{ date: string; start: string; end: string } | null>(null);
	const [forward, setForward] = useState<{ to: string[]; comment: string } | null>(null);
	const [teamsOpen, setTeamsOpen] = useState(false);

	useEffect(() => {
		let alive = true;
		setDetail(null);
		setLoadError(null);
		getOutlookEvent({ identityPublicId, source: refOf(source), id: event.id, tz })
			.catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
			.then((res) => {
				if (!alive) return;
				if (!res.ok) setLoadError(res.error);
				else {
					setDetail(res.event);
					setPerm({ editable: res.editable, canRespond: res.canRespond });
				}
			});
		return () => {
			alive = false;
		};
	}, [event.id, identityPublicId, source, tz]);

	useEffect(() => {
		const down = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			// Les listes deroulantes de Mantine s'ouvrent hors de la fenetre.
			if (ref.current && !ref.current.contains(target) && !target.closest("[data-portal]")) onClose();
		};
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		const t = setTimeout(() => document.addEventListener("mousedown", down), 0);
		document.addEventListener("keydown", key);
		return () => {
			clearTimeout(t);
			document.removeEventListener("mousedown", down);
			document.removeEventListener("keydown", key);
		};
	}, [onClose]);

	const e: CalendarEvent = detail ?? event;
	const W = 440;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const left = rect.right + 8 + W < vw ? rect.right + 8 : Math.max(8, rect.left - 8 - W);
	const top = Math.min(Math.max(8, rect.top), Math.max(8, vh - 640));
	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const line = nouvelle ? "border-k-line" : "border-border";

	const meeting = !!detail && detail.attendees.some((a) => a.address !== detail.organizerAddress);
	const recurring = !!detail?.seriesMasterId;
	const invitation = perm.canRespond;

	const run = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
		setBusy(what);
		setError(null);
		const res = await fn().catch((err: unknown) => ({ ok: false, error: String((err as Error)?.message ?? err) }));
		setBusy(null);
		if (!res.ok) {
			setError(res.error ?? "Erreur");
			return;
		}
		onChanged(done);
	};

	const proposals = (detail?.attendees ?? []).filter((a) => a.proposed);
	const previewKey = JSON.stringify([
		...(detail?.isOrganizer ? proposals.map((a) => [a.proposed?.start, a.proposed?.end, a.name ?? a.address]) : []),
		propose ? [`${propose.date}T${propose.start}`, `${propose.date}T${propose.end}`, "moi"] : null,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: previewKey resume proposals et propose
	useEffect(() => {
		if (!onPreview) return;
		const slots = [
			...(detail?.isOrganizer ? proposals.map((a) => ({ start: a.proposed!.start, end: a.proposed!.end, label: `Proposé par ${a.name ?? a.address}` })) : []),
			...(propose && propose.start < propose.end ? [{ start: `${propose.date}T${propose.start}`, end: `${propose.date}T${propose.end}`, label: "Votre proposition" }] : []),
		];
		onPreview(slots.length ? slots : null);
	}, [previewKey]);
	useEffect(() => () => onPreview?.(null), [onPreview]);

	const proposed = propose && propose.start < propose.end ? { start: `${propose.date}T${propose.start}`, end: `${propose.date}T${propose.end}` } : undefined;
	const respond = (r: InviteResponse) =>
		run(
			r,
			() =>
				respondOutlookEvent({
					identityPublicId,
					id: event.id,
					response: r,
					comment: comment.trim() || undefined,
					proposed: r !== "accept" ? proposed : undefined,
					tz,
				}),
			r === "accept"
				? "Invitation acceptée"
				: proposed
					? "Autre horaire proposé à l'organisateur"
					: r === "decline"
						? "Invitation refusée"
						: "Réponse provisoire envoyée",
		);

	// Organisateur : un participant propose un autre horaire, on l'accepte (mise a jour envoyee a tous).
	const acceptProposal = (p: { start: string; end: string }) =>
		run(
			"proposal",
			() => moveOutlookEvent({ identityPublicId, source: refOf(source), id: event.id, allDay: false, start: p.start, end: p.end, tz }),
			"Horaire modifié, participants prévenus",
		);

	const sendForward = () =>
		forward &&
		run("forward", () => forwardOutlookEvent({ identityPublicId, id: event.id, to: forward.to, comment: forward.comment.trim() || undefined }), "Invitation transférée");

	const fetchAttachment = async (id: string) => {
		setBusy(`att:${id}`);
		const res = await outlookAttachment({ identityPublicId, source: refOf(source), eventId: event.id, attachmentId: id }).catch((e: unknown) => ({
			ok: false as const,
			error: String((e as Error)?.message ?? e),
		}));
		setBusy(null);
		if (!res.ok) setError(res.error);
		else download(res.file.name, res.file.contentType, res.file.base64);
	};

	const remove = () =>
		run(
			"delete",
			() => deleteOutlookEvent({ identityPublicId, source: refOf(source), id: event.id, comment: comment.trim() || undefined, scope }),
			detail?.isOrganizer && meeting ? "Réunion annulée, participants prévenus" : invitation ? "Invitation refusée et retirée" : "Événement supprimé",
		);

	const edit = () => {
		if (!detail || !source) return;
		onEdit({
			id: event.id,
			source: refOf(source),
			sourceKey: source.key,
			seriesMasterId: detail.seriesMasterId,
			initial: inputFromDetail(detail),
			hadBody: !!detail.bodyHtml.trim(),
			attachments: detail.attachments,
			isOrganizer: detail.isOrganizer,
		});
	};

	// ss2i : toutes les informations de l'evenement en texte, pour un agent IA (Samuel le 10/11).
	const copyEvent = () => {
		const d = detail ?? undefined;
		const text = formatEventForCopy(d ?? e, {
			notes: d?.bodyHtml?.trim() ? htmlToText(d.bodyHtml) : undefined,
			calendarName: source?.name,
		});
		navigator.clipboard.writeText(text).then(
			() => toast.success("Événement copié dans le presse-papiers", { description: `${text.length.toLocaleString("fr-FR")} caractères` }),
			() => toast.error("Événement non copié", { description: "Le presse-papiers a refusé l'écriture." }),
		);
	};

	const body = detail?.bodyHtml?.trim() ? DOMPurify.sanitize(detail.bodyHtml, { FORBID_TAGS: ["style", "img"], FORBID_ATTR: ["style"] }) : "";

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={e.title}
			className={`fixed z-[300] flex max-h-[min(720px,calc(100vh-16px))] flex-col rounded-lg border text-sm shadow-lg ${
				nouvelle ? "border-k-line bg-k-surface text-k-ink shadow-k-pop" : "bg-popover text-popover-foreground"
			}`}
			style={{ left, top, width: W }}
		>
			<div className="k-scroll min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
				<div className="flex items-start gap-2">
					<span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: e.color ?? source?.color ?? "#4f8de8" }} />
					<div className="min-w-0 flex-1">
						<div className="font-semibold leading-snug">{e.title}</div>
						<div className="text-[13px]">{agendaWhen({ ...e, sourceQuote: "" })}</div>
						{detail?.recurrenceLabel && (
							<div className={`flex items-center gap-1 text-[12px] ${muted}`}>
								<Repeat className="h-3 w-3" /> {detail.recurrenceLabel}
							</div>
						)}
					</div>
					{/* ss2i : Modifier et Supprimer, Copier en dessous (petite grille 2 x 2) */}
					<div className="grid shrink-0 grid-cols-2 gap-0.5">
						{perm.editable && detail && (
							<button type="button" onClick={edit} aria-label="Modifier" title="Modifier" className={`shrink-0 rounded p-1 ${muted} hover:bg-black/5`}>
								<Pencil className="h-4 w-4" />
							</button>
						)}
						{(perm.editable || invitation) && detail && (
							<button
								type="button"
								onClick={() => setConfirmDelete(true)}
								aria-label="Supprimer"
								title={detail.isOrganizer && meeting ? "Annuler la réunion" : "Supprimer"}
								className={`shrink-0 rounded p-1 ${muted} hover:bg-black/5`}
							>
								<Trash2 className="h-4 w-4" />
							</button>
						)}
						<button type="button" onClick={copyEvent} aria-label="Copier l'événement" title="Copier toutes les informations de l'événement" className={`shrink-0 rounded p-1 ${muted} hover:bg-black/5`}>
							<Copy className="h-4 w-4" />
						</button>
					</div>
					<button type="button" onClick={onClose} aria-label="Fermer" className={`shrink-0 rounded p-1 ${muted} hover:bg-black/5`}>
						<X className="h-4 w-4" />
					</button>
				</div>

				{detail?.isOrganizer && perm.editable && proposals.length > 0 && (
					<div className="space-y-2">
						{proposals.map((a) => (
							<div key={a.address} className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[12.5px] dark:border-amber-700 dark:bg-amber-950/40">
								<div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300">
									<Clock className="h-3.5 w-3.5 shrink-0" />
									{a.name && a.name !== a.address ? a.name : a.address} propose un autre horaire
								</div>
								<div className="mt-1 text-[14px] font-semibold">{when(a.proposed!.start, a.proposed!.end)}</div>
								<div className={`text-[12px] ${muted}`}>au lieu de {when(detail.start, detail.end)}</div>
								<div className="mt-2 flex flex-wrap gap-1.5">
									<Button size="compact-sm" color="green" leftSection={<Check size={13} />} loading={busy === "proposal"} onClick={() => void acceptProposal(a.proposed!)}>
										Accepter ce nouvel horaire
									</Button>
								</div>
								<div className={`mt-1 text-[11px] ${muted}`}>En acceptant, la réunion est déplacée et tous les participants sont prévenus. Sinon, l'horaire actuel reste.</div>
							</div>
						))}
					</div>
				)}

				{(detail?.joinUrl ?? e.joinUrl) && (
					<a
						href={detail?.joinUrl ?? e.joinUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1.5 rounded-md bg-[#5b5fc7] px-2.5 py-1 text-[12.5px] font-medium text-white hover:opacity-90"
					>
						<Video className="h-3.5 w-3.5" /> Rejoindre la réunion Teams
					</a>
				)}
				{e.location && (
					<div className={`flex items-center gap-1 text-[13px] ${muted}`}>
						<MapPin className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{e.location}</span>
					</div>
				)}
				{detail?.room && (
					<div className={`flex items-center gap-1 text-[13px] ${muted}`}>
						<Building2 className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{detail.room.name}</span>
						{(() => {
							const r = detail.attendees.find((a) => a.address === detail.room?.address)?.response;
							return r === "accepted" ? <span className="text-[11px] text-green-600">réservée</span> : r === "declined" ? <span className="text-[11px] text-red-600">refusée</span> : null;
						})()}
					</div>
				)}
				{!!detail?.categories.length && (
					<div className="flex flex-wrap gap-1">
						{detail.categories.map((c) => {
							const color = categories.find((x) => x.name === c)?.color ?? "#9aa0a6";
							return (
								<span key={c} className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px]" style={{ background: `color-mix(in srgb, ${color} 20%, transparent)` }}>
									<span className="h-2 w-2 rounded-sm" style={{ background: color }} />
									{c}
								</span>
							);
						})}
					</div>
				)}
				{e.isPrivate && (
					<div className={`flex items-center gap-1 text-[12px] ${muted}`}>
						<Lock className="h-3 w-3" /> Privé
					</div>
				)}
				{source && (
					<div className={`text-[12px] ${muted}`}>
						{source.kind === "colleague" ? `Agenda de ${source.name} · ${source.roleLabel}` : source.name}
					</div>
				)}

				{!detail && !loadError && (
					<div className={`flex items-center gap-2 text-[12px] ${muted}`}>
						<Loader size="xs" /> Lecture dans Outlook…
					</div>
				)}
				{loadError && <div className={`text-[12px] ${muted}`}>{loadError}</div>}

				{detail && (detail.organizerAddress || detail.attendees.length > 0) && (
					<div className={`space-y-1 border-t pt-2 ${line}`}>
						<div className={`flex items-center gap-1 text-[12px] font-medium ${muted}`}>
							<Users className="h-3.5 w-3.5" />
							{detail.attendees.length ? `${detail.attendees.length + (detail.attendees.some((a) => a.address === detail.organizerAddress) ? 0 : 1)} personnes` : "Organisateur"}
						</div>
						{detail.organizerAddress && !detail.attendees.some((a) => a.address === detail.organizerAddress) && (
							<div className="flex items-center gap-2 text-[12.5px]">
								<span className="min-w-0 flex-1 truncate">{detail.organizer ?? detail.organizerAddress}</span>
								<span className={`text-[11px] ${muted}`}>Organisateur</span>
							</div>
						)}
						{detail.attendees.slice(0, 12).map((a) => (
							<div key={a.address} className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
								<span className="min-w-0 flex-1 truncate" title={a.address}>
									{a.name && a.name !== a.address ? a.name : a.address}
									{a.type === "optional" && <span className={`ml-1 text-[11px] ${muted}`}>(facultatif)</span>}
								</span>
								<span className={`text-[11px] ${RESPONSE[a.response ?? "none"]?.cls ?? ""}`}>{RESPONSE[a.response ?? "none"]?.label}</span>
								{a.proposed && <span className="basis-full pl-2 text-[11px] font-medium text-amber-700 dark:text-amber-400">a proposé un autre horaire</span>}
							</div>
						))}
						{detail.attendees.length > 12 && <div className={`text-[11.5px] ${muted}`}>et {detail.attendees.length - 12} autres</div>}
					</div>
				)}

				{!!detail?.attachments.filter((a) => !a.isInline).length && (
					<div className={`space-y-1 border-t pt-2 ${line}`}>
						{detail.attachments
							.filter((a) => !a.isInline)
							.map((a) => (
								<button
									type="button"
									key={a.id}
									onClick={() => void fetchAttachment(a.id)}
									className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12.5px] hover:bg-black/5"
									title="Télécharger"
								>
									{busy === `att:${a.id}` ? <Loader size={12} /> : <Paperclip className="h-3.5 w-3.5 shrink-0" />}
									<span className="min-w-0 flex-1 truncate">{a.name}</span>
									<span className={`text-[11px] ${muted}`}>{a.size >= 1048576 ? `${(a.size / 1048576).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(a.size / 1024))} Ko`}</span>
								</button>
							))}
					</div>
				)}

				{body && (
					<div
						className={`max-h-64 overflow-y-auto border-t pt-2 text-[12.5px] leading-snug [&_a]:underline [&_p]:my-1 ${line}`}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: corps Outlook nettoye par DOMPurify
						dangerouslySetInnerHTML={{ __html: body }}
					/>
				)}

				{invitation && detail && !confirmDelete && (
					<div className={`space-y-2 border-t pt-2 ${line}`}>
						<div className={`text-[12px] ${muted}`}>
							Votre réponse : <span className="font-medium">{RESPONSE[detail.responseStatus]?.label ?? "Pas de réponse"}</span>
						</div>
						<div className="flex flex-wrap gap-1.5">
							<Button size="compact-xs" variant={detail.responseStatus === "accepted" ? "filled" : "default"} leftSection={<Check size={12} />} loading={busy === "accept"} onClick={() => void respond("accept")}>
								Accepter
							</Button>
							<Button size="compact-xs" variant={detail.responseStatus === "tentativelyAccepted" ? "filled" : "default"} leftSection={<CircleHelp size={12} />} loading={busy === "tentativelyAccept"} onClick={() => void respond("tentativelyAccept")}>
								Provisoire
							</Button>
							<Button size="compact-xs" variant="default" color="red" leftSection={<X size={12} />} loading={busy === "decline"} onClick={() => void respond("decline")}>
								Refuser
							</Button>
							{detail.allowNewTimeProposals && !detail.allDay && (
								<Button
									size="compact-xs"
									variant={propose ? "filled" : "default"}
									color="yellow"
									leftSection={<Clock size={12} />}
									onClick={() => setPropose(propose ? null : { date: detail.start.slice(0, 10), start: detail.start.slice(11, 16), end: detail.end.slice(11, 16) })}
								>
									Proposer un horaire
								</Button>
							)}
							<button type="button" className={`text-[11.5px] underline ${muted}`} onClick={() => setRespondWith(respondWith ? null : "accept")}>
								{respondWith ? "Sans message" : "Ajouter un message"}
							</button>
						</div>
						{respondWith && <Textarea size="xs" autosize minRows={2} placeholder="Message pour l'organisateur" value={comment} onChange={(x) => setComment(x.currentTarget.value)} />}
						{propose && (
							<div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-700 dark:bg-amber-950/40">
								<div className="text-[12.5px] font-semibold text-amber-800 dark:text-amber-300">Proposer un autre horaire à l'organisateur</div>
								<div className="flex flex-wrap items-end gap-1.5">
									<TextInput size="xs" type="date" label="Date" value={propose.date} onChange={(x) => x.currentTarget.value && setPropose({ ...propose, date: x.currentTarget.value })} />
									<TextInput
										size="xs"
										type="time"
										label="Début"
										value={propose.start}
										onChange={(x) => {
											const v = x.currentTarget.value;
											if (!v) return;
											// la duree est gardee quand le debut change
											const len = Math.max(15, toMin(propose.end) - toMin(propose.start));
											setPropose({ ...propose, start: v, end: fromMin(Math.min(toMin(v) + len, 23 * 60 + 59)) });
										}}
									/>
									<TextInput size="xs" type="time" label="Fin" value={propose.end} onChange={(x) => x.currentTarget.value && setPropose({ ...propose, end: x.currentTarget.value })} />
								</div>
								<Textarea size="xs" autosize minRows={1} placeholder="Message (facultatif)" value={comment} onChange={(x) => setComment(x.currentTarget.value)} />
								<div className="flex flex-wrap gap-1.5">
									<Button size="compact-sm" disabled={!proposed} loading={busy === "tentativelyAccept"} onClick={() => void respond("tentativelyAccept")}>
										Envoyer (je réponds provisoire)
									</Button>
									<Button size="compact-sm" variant="default" color="red" disabled={!proposed} loading={busy === "decline"} onClick={() => void respond("decline")}>
										Envoyer (je refuse cet horaire)
									</Button>
								</div>
								<div className={`text-[11px] ${muted}`}>Le créneau proposé apparaît en pointillés sur l'agenda.</div>
							</div>
						)}
					</div>
				)}

				{forward && detail && (
					<div className={`space-y-1.5 border-t pt-2 ${line}`}>
						<TagsInput
							size="xs"
							label="Transférer l'invitation à"
							placeholder="Adresses e-mail"
							value={forward.to}
							onChange={(to) => setForward({ ...forward, to: to.map((x) => x.trim().toLowerCase()) })}
							splitChars={[",", ";", " "]}
							acceptValueOnBlur
						/>
						<Textarea size="xs" autosize minRows={2} placeholder="Message (facultatif)" value={forward.comment} onChange={(x) => setForward({ ...forward, comment: x.currentTarget.value })} />
						<div className="flex justify-end gap-2">
							<Button size="compact-sm" variant="default" onClick={() => setForward(null)}>
								Retour
							</Button>
							<Button size="compact-sm" loading={busy === "forward"} disabled={!forward.to.length} onClick={() => void sendForward()}>
								Transférer
							</Button>
						</div>
					</div>
				)}

				{confirmDelete && detail && (
					<div className={`space-y-2 border-t pt-2 ${line}`}>
						<div className="text-[12.5px] font-medium">
							{detail.isOrganizer && meeting
								? "Annuler cette réunion ? Les participants recevront l'annulation."
								: invitation
									? "Refuser et retirer cette invitation ? L'organisateur sera prévenu."
									: "Supprimer cet événement de l'agenda Outlook ?"}
						</div>
						{recurring && (
							<div className="flex gap-3 text-[12px]">
								<label className="flex items-center gap-1">
									<input type="radio" checked={scope === "occurrence"} onChange={() => setScope("occurrence")} /> Cette occurrence
								</label>
								<label className="flex items-center gap-1">
									<input type="radio" checked={scope === "series"} onChange={() => setScope("series")} /> Toute la série
								</label>
							</div>
						)}
						{(meeting || invitation) && (
							<Textarea size="xs" autosize minRows={2} placeholder="Message (facultatif)" value={comment} onChange={(x) => setComment(x.currentTarget.value)} />
						)}
						<div className="flex justify-end gap-2">
							<Button size="compact-sm" variant="default" onClick={() => setConfirmDelete(false)}>
								Retour
							</Button>
							<Button size="compact-sm" color="red" loading={busy === "delete"} onClick={() => void remove()}>
								{detail.isOrganizer && meeting ? "Annuler la réunion" : invitation ? "Refuser" : "Supprimer"}
							</Button>
						</div>
					</div>
				)}

				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-[12px] text-red-800" role="alert">
						{error}
					</div>
				)}
			</div>

			{(detail?.webLink ?? e.webLink) && (
				<div className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 ${line}`}>
					{detail && source?.kind === "own" && meeting && !forward && (
						<button type="button" onClick={() => setForward({ to: [], comment: "" })} className={`inline-flex items-center gap-1 text-[12.5px] ${muted} hover:underline`}>
							<Forward className="h-3 w-3" /> Transférer
						</button>
					)}
					{detail && source?.kind === "own" && detail.isOrganizer && detail.joinUrl && (
						<button type="button" onClick={() => setTeamsOpen(true)} className={`inline-flex items-center gap-1 text-[12.5px] ${muted} hover:underline`}>
							<Settings2 className="h-3 w-3" /> Options Teams
						</button>
					)}
					<a
						href={detail?.webLink ?? e.webLink}
						target="_blank"
						rel="noopener noreferrer"
						className={`inline-flex items-center gap-1 text-[12.5px] font-medium ${nouvelle ? "text-k-accent" : "text-primary"} hover:underline`}
					>
						Ouvrir dans Outlook <ExternalLink className="h-3 w-3" />
					</a>
				</div>
			)}
			{teamsOpen && (
				<TeamsOptionsModal identityPublicId={identityPublicId} eventId={event.id} opened={teamsOpen} onClose={() => setTeamsOpen(false)} onSaved={(m) => toast.success(m)} />
			)}
		</div>
	);
}
