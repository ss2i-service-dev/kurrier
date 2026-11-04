"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Loader, Modal, TextInput } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconCalendarPlus } from "@tabler/icons-react";
import { toast } from "sonner";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { addThreadEventsToAgenda, agendaAvailable, analyzeThreadForAgenda } from "@/lib/actions/thread-agenda";
import type { AgendaEvent } from "@common/thread-agenda";

// ss2i : « Ajouter a l'agenda » depuis un fil ouvert (OI 10280), meme fenetre dans les deux
// interfaces. Le fil est analyse a l'ouverture (propositions du LLM), chaque proposition se
// corrige ou se decoche, rien n'est cree avant « Ajouter a mon agenda ». Verrou de saisie
// (ss2i-shortcuts.js) : la fenetre est un role="dialog", son clavier lui appartient ; aucun
// focus n'est deplace quand les propositions arrivent.

const availability = new Map<string, Promise<boolean>>();

function useAgendaAvailable(identityPublicId: string | undefined) {
	const [ok, setOk] = useState(false);
	useEffect(() => {
		if (!identityPublicId) return;
		let alive = true;
		let p = availability.get(identityPublicId);
		if (!p) {
			p = agendaAvailable(identityPublicId).catch(() => false);
			availability.set(identityPublicId, p);
		}
		p.then((v) => alive && setOk(v));
		return () => {
			alive = false;
		};
	}, [identityPublicId]);
	return ok;
}

type Row = AgendaEvent & { key: number; checked: boolean; error?: string };

// Interface « Outlook » (<html data-ui="ss2i">) : toast centre, comme client-link.ts.
const toastPosition = () =>
	typeof document !== "undefined" && document.documentElement.dataset.ui === "ss2i" ? "bottom-center" : "bottom-left";

const datePart = (v: string) => v.slice(0, 10);
const timePart = (v: string) => (v.length >= 16 ? v.slice(11, 16) : "");

export function AddToAgenda({
	identityPublicId,
	threadId,
	trigger,
}: {
	identityPublicId: string | undefined;
	threadId: string;
	trigger: (open: () => void) => React.ReactNode;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const available = useAgendaAvailable(identityPublicId);
	const [opened, { open, close }] = useDisclosure(false);
	const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [error, setError] = useState<string | null>(null);
	const [mailbox, setMailbox] = useState<string>("");
	const [rows, setRows] = useState<Row[]>([]);
	const [saving, setSaving] = useState(false);
	const analyzedFor = useRef<string | null>(null);
	const request = useRef(0);
	const busy = useRef(false);

	const analyze = () => {
		if (!identityPublicId) return;
		const id = ++request.current;
		analyzedFor.current = threadId;
		setPhase("loading");
		setError(null);
		setRows([]);
		analyzeThreadForAgenda({ threadId, identityPublicId })
			.catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }))
			.then((res) => {
				if (id !== request.current) return; // fil change ou nouvelle analyse entre-temps
				if (!res.ok) {
					analyzedFor.current = null;
					setError(res.error);
					setPhase("error");
					return;
				}
				setMailbox(res.mailbox);
				setRows(res.events.map((e, i) => ({ ...e, key: i, checked: true })));
				setPhase("ready");
			});
	};

	// Un autre fil dans la meme barre (nouvelle interface) : l'analyse precedente ne vaut plus.
	useEffect(() => {
		if (analyzedFor.current && analyzedFor.current !== threadId) {
			request.current++;
			analyzedFor.current = null;
			setPhase("idle");
			setRows([]);
		}
	}, [threadId]);

	if (!available || !identityPublicId) return null;

	const openDialog = () => {
		open();
		if (analyzedFor.current !== threadId) analyze();
	};

	const update = (key: number, patch: Partial<Row>) =>
		setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch, error: undefined } : r)));

	// Journee entiere <-> horaire : on garde les jours, 09:00-10:00 par defaut a corriger.
	const toggleAllDay = (r: Row, allDay: boolean) =>
		update(
			r.key,
			allDay
				? { allDay, start: datePart(r.start), end: datePart(r.end) }
				: { allDay, start: `${datePart(r.start)}T09:00`, end: `${datePart(r.start)}T10:00` },
		);

	const setDate = (r: Row, which: "start" | "end", date: string) =>
		update(r.key, { [which]: r.allDay ? date : `${date}T${timePart(r[which]) || "09:00"}` });
	const setTime = (r: Row, which: "start" | "end", time: string) =>
		update(r.key, { [which]: `${datePart(r[which])}T${time}` });

	const selected = rows.filter((r) => r.checked);

	const submit = async () => {
		if (busy.current || !selected.length) return;
		busy.current = true;
		setSaving(true);
		setError(null);
		const chosen = selected;
		const res = await addThreadEventsToAgenda({
			threadId,
			identityPublicId,
			events: chosen.map(({ key, checked, error, ...e }) => e),
		}).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }));
		busy.current = false;
		setSaving(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		const done = new Set<number>();
		const failed = new Map<number, string>();
		res.results.forEach((r, i) => (r.ok ? done.add(chosen[i].key) : failed.set(chosen[i].key, r.error ?? "Erreur")));
		const position = toastPosition();
		if (done.size) {
			toast.success(
				k(
					`${done.size} event${done.size > 1 ? "s" : ""} added to the calendar of ${res.mailbox}`,
					`${done.size > 1 ? `${done.size} événements ajoutés` : "Événement ajouté"} à l'agenda de ${res.mailbox}`,
				),
				{ position },
			);
		}
		if (!failed.size) {
			// Tout est cree : une prochaine ouverture repart d'une nouvelle analyse.
			analyzedFor.current = null;
			setPhase("idle");
			setRows([]);
			close();
			return;
		}
		// Les evenements crees sortent de la liste (pas de doublon en reessayant les autres).
		setRows((list) =>
			list.filter((r) => !done.has(r.key)).map((r) => (failed.has(r.key) ? { ...r, error: failed.get(r.key) } : r)),
		);
		toast.error(
			k(`${failed.size} event${failed.size > 1 ? "s" : ""} not added`, `${failed.size > 1 ? `${failed.size} événements non ajoutés` : "Événement non ajouté"}`),
			{ position },
		);
	};

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const card = nouvelle ? "rounded-k-sm border border-k-line p-3" : "rounded-md border p-3";

	return (
		<>
			{trigger(openDialog)}
			<Modal opened={opened} onClose={close} size="lg" title={k("Add to calendar", "Ajouter à l'agenda")}>
				<div className="space-y-3">
					{phase === "loading" && (
						<div className={`flex items-center gap-2 py-6 text-sm ${muted}`} role="status">
							<Loader size="sm" />
							{k("Reading the conversation for dates…", "Analyse du fil en cours (recherche des dates)…")}
						</div>
					)}

					{error && (
						<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
							{error}
						</div>
					)}
					{phase === "error" && (
						<Button variant="default" size="xs" onClick={analyze}>
							{k("Try again", "Réessayer")}
						</Button>
					)}

					{phase === "ready" && !rows.length && (
						<div className={`py-4 text-sm ${muted}`}>
							{k("No dated event found in this conversation.", "Aucun événement daté n'a été trouvé dans ce fil.")}
						</div>
					)}

					{phase === "ready" && rows.length > 0 && (
						<>
							<div className={`text-xs ${muted}`}>
								{k(
									`Proposals to check: nothing is created before you confirm. Outlook calendar of ${mailbox}.`,
									`Propositions à vérifier : rien n'est créé avant votre validation. Agenda Outlook de ${mailbox}.`,
								)}
							</div>
							<ul className="max-h-[60vh] space-y-2 overflow-y-auto">
								{rows.map((r) => (
									<li key={r.key} className={`${card} space-y-2 ${r.checked ? "" : "opacity-60"}`}>
										<div className="flex items-center gap-2">
											<Checkbox
												checked={r.checked}
												onChange={(e) => update(r.key, { checked: e.currentTarget.checked })}
												aria-label={k("Add this event", "Ajouter cet événement")}
											/>
											<TextInput
												className="min-w-0 flex-1"
												size="xs"
												value={r.title}
												onChange={(e) => update(r.key, { title: e.currentTarget.value })}
												aria-label={k("Title", "Titre")}
											/>
										</div>
										<Checkbox
											size="xs"
											label={k("All day", "Journée entière")}
											checked={r.allDay}
											onChange={(e) => toggleAllDay(r, e.currentTarget.checked)}
										/>
										<div className="flex flex-wrap items-end gap-x-4 gap-y-2">
											{(["start", "end"] as const).map((which) => (
												<div key={which} className="flex items-end gap-1">
													<TextInput
														size="xs"
														type="date"
														label={which === "start" ? k("Start", "Début") : r.allDay ? k("End (included)", "Fin (incluse)") : k("End", "Fin")}
														value={datePart(r[which])}
														onChange={(e) => e.currentTarget.value && setDate(r, which, e.currentTarget.value)}
													/>
													{!r.allDay && (
														<TextInput
															size="xs"
															type="time"
															aria-label={which === "start" ? k("Start time", "Heure de début") : k("End time", "Heure de fin")}
															value={timePart(r[which])}
															onChange={(e) => e.currentTarget.value && setTime(r, which, e.currentTarget.value)}
														/>
													)}
												</div>
											))}
										</div>
										<TextInput
											size="xs"
											placeholder={k("Location", "Lieu")}
											aria-label={k("Location", "Lieu")}
											value={r.location ?? ""}
											onChange={(e) => update(r.key, { location: e.currentTarget.value })}
										/>
										{r.sourceQuote && <div className={`text-xs italic ${muted}`}>« {r.sourceQuote} »</div>}
										{r.error && (
											<div className="text-xs text-red-700" role="alert">
												{r.error}
											</div>
										)}
									</li>
								))}
							</ul>
						</>
					)}

					<div className="flex justify-end gap-2 pt-1">
						<Button variant="default" size="sm" onClick={close}>
							{phase === "ready" && rows.length ? k("Cancel", "Annuler") : k("Close", "Fermer")}
						</Button>
						{phase === "ready" && rows.length > 0 && (
							// Pas de disabled pendant l'envoi : un bouton desactive perd le focus, qui tombe
							// dans le vide, et le verrou de saisie renverrait les frappes vers l'editeur
							// ouvert derriere la fenetre. Le double clic est ecarte par busy.
							<Button size="sm" onClick={() => void submit()} aria-disabled={!selected.length || saving} data-disabled={!selected.length || undefined}>
								{saving
									? k("Adding…", "Ajout en cours…")
									: k(`Add to my calendar (${selected.length})`, `Ajouter à mon agenda (${selected.length})`)}
							</Button>
						)}
					</div>
				</div>
			</Modal>
		</>
	);
}

/** « Ajouter a l'agenda » dans la barre au-dessus d'un fil (interface classique). */
export function AddToAgendaButton({ identityPublicId, threadId }: { identityPublicId: string; threadId: string }) {
	const k = useK();
	return (
		<AddToAgenda
			identityPublicId={identityPublicId}
			threadId={threadId}
			trigger={(open) => (
				<button
					type="button"
					onClick={open}
					className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-solid hover:text-foreground"
					title={k("Find the dates of this conversation and add them to your Outlook calendar", "Trouver les dates de ce fil et les ajouter à votre agenda Outlook")}
				>
					<IconCalendarPlus size={14} aria-hidden />
					{k("Add to calendar", "Ajouter à l'agenda")}
				</button>
			)}
		/>
	);
}
