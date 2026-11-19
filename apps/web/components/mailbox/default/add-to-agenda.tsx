"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button, Loader, Modal, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconCalendarPlus } from "@tabler/icons-react";
import { toast } from "sonner";
import { useNouvelle } from "@/components/k/ui-context";
import { addThreadEventsToAgenda, agendaAvailable, analyzeThreadForAgenda } from "@/lib/actions/thread-agenda";
import { type AgendaEvent, defaultReminders, normalizeAgendaEvent, proposalAsTimed } from "@common/thread-agenda";
import { type AgendaRow, ConfirmStep, ProposalsStep } from "@/components/mailbox/default/add-to-agenda-steps";
import { placeEvent } from "@common/outlook-calendar";
import { agendaFromMailKey, removeFormBackup, restorableBackup, syncFormBackup } from "@/lib/form-backup";
import PlanningPanel from "@/components/outlook-calendar/planning-panel";

// ss2i : « Ajouter a l'agenda » depuis un fil ouvert (OI 10280), meme fenetre dans les deux
// interfaces, en francais dans les deux. Le fil est analyse a l'ouverture (propositions du
// LLM) ; etape 1, chaque proposition se corrige ou se decoche ; etape 2, recapitulatif de ce
// qui sera cree et rappels de chaque evenement (trois rappels coches par defaut, Samuel,
// 19/11). Jamais de journee entiere d'emblee : une proposition sans heure devient 09:00-10:00
// (ou 09:00 a 18:00 sur plusieurs jours), signalee « Heure a verifier ». Seul « Confirmer »
// ecrit dans Outlook, « Retour » rend les propositions telles quelles.
// Verrou de saisie (ss2i-shortcuts.js) : la fenetre est un role="dialog", son clavier lui
// appartient ; aucun focus n'est deplace a l'arrivee des propositions. Un bouton clique qui
// disparait (changement d'etape) laisserait le focus dans le vide, et le verrou renverrait les
// frappes vers l'editeur ouvert derriere : le focus est alors rendu au corps de la fenetre.
// Rien de date dans le fil, ou un evenement de plus : la fenetre demande ce qu'il faut creer
// (« rappel pour relancer le client jeudi ») et le LLM le met en forme a partir du fil, ou
// l'utilisateur le saisit lui-meme (Samuel, 05/11). Un rappel horaire cree ainsi a ses trois
// rappels (1 h, 15 min, a l'heure) coches comme les autres : decochables a l'etape 2.
// Planification (Hugo, 05/11) : a l'etape 1, la fenetre s'elargit et montre a droite deux
// semaines de l'agenda Outlook (PlanningPanel) ; la proposition encadree se place d'un clic
// sur un creneau, en gardant sa duree.
// Copie locale (lib/form-backup.ts, Samuel le 10/11 : « on est en 2026 ») : les propositions
// corrigees et la demande en cours de saisie sont ecrites dans localStorage a chaque
// modification, par fil (la cle est celle du fil ouvert). A la reouverture, une fois le fil
// analyse, la copie prend la place des propositions fraiches (le LLM ne redonne pas deux fois
// la meme liste) et un toast le dit. Elle part quand Outlook a tout cree ou sur « Annuler » ;
// fermer par erreur (clic dehors, Echap) la garde.


/** Etat saisi qui se compare a la copie locale : propositions (corrigees, decochees) et demande en cours. */
type BackupValues = { rows: AgendaRow[]; wish: string };

const isBackupValues = (x: any): x is BackupValues =>
	!!x && typeof x.wish === "string" && Array.isArray(x.rows) && x.rows.every((r: any) => r && typeof r.key === "number" && typeof r.title === "string" && typeof r.start === "string");

// Ligne de l'etape 1 : proposition ramenee a un horaire (jamais de journee entiere d'emblee),
// rappels par defaut coches.
function newRow(e: AgendaEvent, key: number): AgendaRow {
	const { event, timeToCheck } = proposalAsTimed(e);
	return { ...event, reminders: defaultReminders(event.allDay), key, checked: true, timeToCheck };
}

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

// Interface « Outlook » (<html data-ui="ss2i">) : toast centre, comme client-link.ts.
const toastPosition = () =>
	typeof document !== "undefined" && document.documentElement.dataset.ui === "ss2i" ? "bottom-center" : "bottom-left";

const plural = (n: number, one: string, many: string) => (n > 1 ? `${n} ${many}` : one);

/** Prochain jour ouvre apres aujourd'hui (heure du poste), en YYYY-MM-DD. */
function nextWorkingDay(): string {
	const d = new Date();
	do d.setDate(d.getDate() + 1);
	while (d.getDay() === 0 || d.getDay() === 6);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function AddToAgenda({
	identityPublicId,
	threadId,
	trigger,
}: {
	identityPublicId: string | undefined;
	threadId: string;
	trigger: (open: () => void) => React.ReactNode;
}) {
	const nouvelle = useNouvelle();
	const available = useAgendaAvailable(identityPublicId);
	const [opened, { open, close }] = useDisclosure(false);
	const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [step, setStep] = useState<"edit" | "confirm">("edit");
	const [error, setError] = useState<string | null>(null);
	const [mailbox, setMailbox] = useState<string>("");
	const [rows, setRows] = useState<AgendaRow[]>([]);
	const [saving, setSaving] = useState(false);
	const [wish, setWish] = useState("");
	const [asking, setAsking] = useState(false);
	const [askOpen, setAskOpen] = useState(false);
	const [activeKey, setActiveKey] = useState<number | null>(null);
	const nextKey = useRef(0);
	const analyzedFor = useRef<string | null>(null);
	const request = useRef(0);
	const busy = useRef(false);
	const confirmShownAt = useRef(0);
	const bodyRef = useRef<HTMLDivElement>(null);
	// Copie locale du fil analyse : sa cle, et l'etat issu de l'analyse (ce que « Effacer » rend).
	const [backup, setBackup] = useState<{ key: string; initial: BackupValues } | null>(null);
	// Copie retiree (tout cree, « Annuler », « Effacer ») : plus rien ne la reecrit.
	const discarded = useRef<string | null>(null);

	// Apres un clic qui retire le bouton clique : focus rendu a la fenetre s'il est tombe dans le vide.
	const keepFocusInDialog = () =>
		requestAnimationFrame(() => {
			const a = document.activeElement;
			if (!a || a === document.body) bodyRef.current?.focus({ preventScroll: true });
		});

	const analyze = () => {
		if (!identityPublicId) return;
		const id = ++request.current;
		analyzedFor.current = threadId;
		setPhase("loading");
		setStep("edit");
		setError(null);
		setRows([]);
		setWish("");
		setAskOpen(false);
		setBackup(null);
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
				const fresh = res.events.map((e, i) => newRow(e, i));
				const initial: BackupValues = { rows: fresh, wish: "" };
				const key = agendaFromMailKey(threadId);
				const copy = restorableBackup(key, initial);
				const saved = copy && isBackupValues(copy.values) ? copy.values : null;
				discarded.current = null;
				setBackup({ key, initial });
				setMailbox(res.mailbox);
				setPhase("ready");
				if (!saved) {
					setRows(fresh);
					setActiveKey(res.events.length ? 0 : null);
					nextKey.current = res.events.length;
					return;
				}
				setRows(saved.rows);
				setWish(saved.wish);
				setAskOpen(!!saved.wish);
				setActiveKey(saved.rows.find((r) => r.checked)?.key ?? saved.rows[0]?.key ?? null);
				nextKey.current = saved.rows.reduce((n, r) => Math.max(n, r.key + 1), 0);
				toast("Saisie restaurée depuis ce navigateur", {
					id: `form-backup:${key}`,
					position: toastPosition(),
					duration: 12000,
					action: {
						label: "Effacer",
						onClick: () => {
							discarded.current = key;
							removeFormBackup(key);
							setRows(fresh);
							setWish("");
							setAskOpen(false);
							setStep("edit");
							setActiveKey(res.events.length ? 0 : null);
							nextKey.current = res.events.length;
						},
					},
				});
			});
	};

	// Copie locale a chaque modification (propositions, demande en cours) ; retiree si tout revient a l'analyse.
	useEffect(() => {
		if (phase !== "ready" || !backup || discarded.current === backup.key) return;
		syncFormBackup(backup.key, { rows, wish }, backup.initial);
	}, [rows, wish, phase, backup]);

	// « Annuler » : abandon voulu, la copie part et une prochaine ouverture repart de l'analyse.
	const abandon = () => {
		if (backup) {
			discarded.current = backup.key;
			removeFormBackup(backup.key);
		}
		analyzedFor.current = null;
		setPhase("idle");
		setStep("edit");
		setRows([]);
		setWish("");
		setAskOpen(false);
		setBackup(null);
		close();
	};

	// Un autre fil dans la meme barre (nouvelle interface) : l'analyse precedente ne vaut plus.
	useEffect(() => {
		if (analyzedFor.current && analyzedFor.current !== threadId) {
			request.current++;
			analyzedFor.current = null;
			setPhase("idle");
			setStep("edit");
			setRows([]);
			setAsking(false);
			setWish("");
			setAskOpen(false);
			setBackup(null);
		}
	}, [threadId]);

	if (!available || !identityPublicId) return null;

	const openDialog = () => {
		open();
		if (analyzedFor.current !== threadId) analyze();
	};

	const update = (key: number, patch: Partial<AgendaRow>) =>
		setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch, error: undefined } : r)));

	const selected = rows.filter((r) => r.checked);

	const addRows = (events: AgendaEvent[]) => {
		// La nouvelle proposition devient celle que l'agenda place.
		if (events.length) setActiveKey(nextKey.current);
		setRows((list) => [
			...list,
			...events.map((e) => newRow(e, nextKey.current++)),
		]);
	};

	const place = (key: number, date: string, minutes: number | null) =>
		setRows((list) => list.map((r) => (r.key === key ? { ...r, ...placeEvent(r, date, minutes), timeToCheck: false, error: undefined } : r)));

	// Ce que l'utilisateur veut creer, mis en forme par le LLM a partir du fil.
	const ask = () => {
		const text = wish.trim();
		if (!text || asking) return;
		const id = ++request.current;
		setAsking(true);
		setError(null);
		analyzeThreadForAgenda({ threadId, identityPublicId, request: text })
			.catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }))
			.then((res) => {
				if (id !== request.current) return;
				setAsking(false);
				if (!res.ok) {
					setError(res.error);
					return;
				}
				if (!res.events.length) {
					setError("Rien n'a pu être proposé pour cette demande : précisez ce qu'il faut créer et quand.");
					return;
				}
				setMailbox(res.mailbox);
				addRows(res.events);
				setWish("");
				setAskOpen(false);
				keepFocusInDialog();
			});
	};

	// Saisie libre : un rappel au prochain jour ouvre a 9 h, a corriger dans le formulaire.
	const addBlank = () => {
		if (asking) return;
		const day = nextWorkingDay();
		addRows([{ title: wish.trim().slice(0, 255), allDay: false, start: `${day}T09:00`, end: `${day}T09:15`, sourceQuote: "" }]);
		setWish("");
		setAskOpen(false);
		setError(null);
		keepFocusInDialog();
	};

	// Etape 1 -> 2 : chaque evenement coche est verifie et mis au propre (fin par defaut...).
	const goConfirm = () => {
		if (!selected.length) return;
		const checked = new Map<number, AgendaRow>();
		let invalid = false;
		for (const r of selected) {
			const n = normalizeAgendaEvent(r);
			if ("error" in n) {
				invalid = true;
				checked.set(r.key, { ...r, error: n.error });
			} else checked.set(r.key, { ...r, ...n.event });
		}
		setRows((list) => list.map((r) => checked.get(r.key) ?? r));
		if (invalid) return;
		setError(null);
		setStep("confirm");
		confirmShownAt.current = Date.now();
		keepFocusInDialog();
	};

	const back = () => {
		setStep("edit");
		setError(null);
		keepFocusInDialog();
	};

	const submit = async () => {
		// Double clic sur « Ajouter a mon agenda » : le second ne confirme pas a l'aveugle.
		if (busy.current || !selected.length || Date.now() - confirmShownAt.current < 600) return;
		busy.current = true;
		setSaving(true);
		setError(null);
		const chosen = selected;
		const res = await addThreadEventsToAgenda({
			threadId,
			identityPublicId,
			events: chosen.map(({ key, checked, error, timeToCheck, ...e }) => e),
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
			toast.success(`${plural(done.size, "Événement ajouté", "événements ajoutés")} à l'agenda de ${res.mailbox}`, { position });
		}
		if (!failed.size) {
			// Tout est cree : la copie locale n'a plus d'objet, une prochaine ouverture repart d'une nouvelle analyse.
			if (backup) {
				discarded.current = backup.key;
				removeFormBackup(backup.key);
			}
			setBackup(null);
			analyzedFor.current = null;
			setPhase("idle");
			setStep("edit");
			setRows([]);
			close();
			return;
		}
		// Les evenements crees sortent de la liste (pas de doublon en reessayant les autres).
		setRows((list) =>
			list.filter((r) => !done.has(r.key)).map((r) => (failed.has(r.key) ? { ...r, error: failed.get(r.key) } : r)),
		);
		toast.error(`${plural(failed.size, "Événement non ajouté", "événements non ajoutés")}`, { position });
	};

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const confirming = phase === "ready" && step === "confirm";
	// Etape 1 avec propositions : agenda Outlook a cote (fenetre elargie).
	const planning = phase === "ready" && rows.length > 0 && step === "edit";

	const requestBox = (
		<div className="space-y-2">
			<Textarea
				label="Que voulez-vous créer ?"
				placeholder="Ex. : un rappel pour relancer le client jeudi prochain"
				autosize
				minRows={2}
				maxLength={1000}
				data-autofocus
				autoFocus
				value={wish}
				onChange={(e) => setWish(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						ask();
					}
				}}
			/>
			<div className="flex items-center gap-2">
				<Button size="xs" onClick={ask} aria-disabled={!wish.trim() || asking} data-disabled={!wish.trim() || undefined}>
					{asking ? "Préparation…" : "Proposer"}
				</Button>
				<Button size="xs" variant="subtle" onClick={addBlank} aria-disabled={asking}>
					Saisir moi-même
				</Button>
				{asking && <Loader size="xs" />}
			</div>
		</div>
	);

	return (
		<>
			{trigger(openDialog)}
			<Modal
				opened={opened}
				onClose={close}
				size={planning ? "100%" : "xl"}
				styles={planning ? { content: { maxWidth: 1400 } } : undefined}
				title={confirming ? "Confirmer l'ajout à l'agenda" : "Ajouter à l'agenda"}
			>
				<div ref={bodyRef} tabIndex={-1} className="space-y-3 outline-none">
					{phase === "loading" && (
						<div className={`flex items-center gap-2 py-6 text-sm ${muted}`} role="status">
							<Loader size="sm" />
							Analyse du fil en cours (recherche des dates)…
						</div>
					)}

					{error && (
						<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
							{error}
						</div>
					)}
					{phase === "error" && (
						<Button
							variant="default"
							size="xs"
							onClick={() => {
								analyze();
								keepFocusInDialog();
							}}
						>
							Réessayer
						</Button>
					)}

					{phase === "ready" && !rows.length && (
						<>
							<div className={`pt-2 text-sm ${muted}`}>
								Aucun événement daté n'a été trouvé dans ce fil. Voulez-vous en créer un ?
							</div>
							{requestBox}
						</>
					)}

					{planning && (
						<div className="flex flex-col gap-3 md:grid md:h-[min(72vh,760px)] md:grid-cols-[minmax(320px,380px)_1fr]">
							<div className="flex min-h-0 flex-col gap-2">
								<ProposalsStep
									rows={rows}
									mailbox={mailbox}
									nouvelle={nouvelle}
									onChange={update}
									activeKey={activeKey}
									onActivate={setActiveKey}
									planning
								/>
								{askOpen ? (
									requestBox
								) : (
									<Button className="self-start" variant="subtle" size="xs" onClick={() => setAskOpen(true)}>
										+ Créer un autre événement
									</Button>
								)}
							</div>
							<div className="h-[60vh] min-h-0 md:h-auto">
								<PlanningPanel
									identityPublicId={identityPublicId}
									proposals={rows}
									activeKey={activeKey}
									nouvelle={nouvelle}
									onPlace={place}
									onActivate={setActiveKey}
								/>
							</div>
						</div>
					)}
					{confirming && (
						<ConfirmStep
							rows={selected}
							mailbox={mailbox}
							nouvelle={nouvelle}
							onReminders={(key, reminders) => update(key, { reminders })}
						/>
					)}

					{/* Cles distinctes : React ne recycle pas « Ajouter a mon agenda » en « Confirmer ». */}
					<div className="flex justify-end gap-2 pt-1">
						{confirming ? (
							<Button key="back" variant="default" size="sm" onClick={back}>
								Retour
							</Button>
						) : (
							<Button key="close" variant="default" size="sm" onClick={phase === "ready" && rows.length ? abandon : close}>
								{phase === "ready" && rows.length ? "Annuler" : "Fermer"}
							</Button>
						)}
						{phase === "ready" && rows.length > 0 && step === "edit" && (
							<Button key="next" size="sm" onClick={goConfirm} aria-disabled={!selected.length} data-disabled={!selected.length || undefined}>
								Ajouter à mon agenda ({selected.length})
							</Button>
						)}
						{confirming && (
							// Pas de disabled pendant l'envoi : un bouton desactive perd le focus (voir
							// plus haut). Le double clic est ecarte par busy.
							<Button key="confirm" size="sm" onClick={() => void submit()} aria-disabled={saving}>
								{saving ? "Ajout en cours…" : "Confirmer"}
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
	return (
		<AddToAgenda
			identityPublicId={identityPublicId}
			threadId={threadId}
			trigger={(open) => (
				<button
					type="button"
					onClick={open}
					className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-solid hover:text-foreground"
					title="Trouver les dates de ce fil et les ajouter à votre agenda Outlook"
				>
					<IconCalendarPlus size={14} aria-hidden />
					Ajouter à l'agenda
				</button>
			)}
		/>
	);
}
