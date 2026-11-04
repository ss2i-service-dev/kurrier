"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button, Loader, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconCalendarPlus } from "@tabler/icons-react";
import { toast } from "sonner";
import { useNouvelle } from "@/components/k/ui-context";
import { addThreadEventsToAgenda, agendaAvailable, analyzeThreadForAgenda } from "@/lib/actions/thread-agenda";
import { type AgendaReminder, normalizeAgendaEvent } from "@common/thread-agenda";
import { type AgendaRow, ConfirmStep, ProposalsStep } from "@/components/mailbox/default/add-to-agenda-steps";

// ss2i : « Ajouter a l'agenda » depuis un fil ouvert (OI 10280), meme fenetre dans les deux
// interfaces, en francais dans les deux. Le fil est analyse a l'ouverture (propositions du
// LLM) ; etape 1, chaque proposition se corrige ou se decoche ; etape 2, recapitulatif de ce
// qui sera cree et rappel de chaque evenement (« Aucun rappel » par defaut). Seul « Confirmer »
// ecrit dans Outlook, « Retour » rend les propositions telles quelles.
// Verrou de saisie (ss2i-shortcuts.js) : la fenetre est un role="dialog", son clavier lui
// appartient ; aucun focus n'est deplace a l'arrivee des propositions. Un bouton clique qui
// disparait (changement d'etape) laisserait le focus dans le vide, et le verrou renverrait les
// frappes vers l'editeur ouvert derriere : le focus est alors rendu au corps de la fenetre.

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
	const analyzedFor = useRef<string | null>(null);
	const request = useRef(0);
	const busy = useRef(false);
	const confirmShownAt = useRef(0);
	const bodyRef = useRef<HTMLDivElement>(null);

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
			setStep("edit");
			setRows([]);
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
			toast.success(`${plural(done.size, "Événement ajouté", "événements ajoutés")} à l'agenda de ${res.mailbox}`, { position });
		}
		if (!failed.size) {
			// Tout est cree : une prochaine ouverture repart d'une nouvelle analyse.
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

	return (
		<>
			{trigger(openDialog)}
			<Modal opened={opened} onClose={close} size="lg" title={confirming ? "Confirmer l'ajout à l'agenda" : "Ajouter à l'agenda"}>
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
						<div className={`py-4 text-sm ${muted}`}>Aucun événement daté n'a été trouvé dans ce fil.</div>
					)}

					{phase === "ready" && rows.length > 0 && step === "edit" && (
						<ProposalsStep rows={rows} mailbox={mailbox} nouvelle={nouvelle} onChange={update} />
					)}
					{confirming && (
						<ConfirmStep
							rows={selected}
							mailbox={mailbox}
							nouvelle={nouvelle}
							onReminder={(key, reminder: AgendaReminder) => update(key, { reminder })}
						/>
					)}

					{/* Cles distinctes : React ne recycle pas « Ajouter a mon agenda » en « Confirmer ». */}
					<div className="flex justify-end gap-2 pt-1">
						{confirming ? (
							<Button key="back" variant="default" size="sm" onClick={back}>
								Retour
							</Button>
						) : (
							<Button key="close" variant="default" size="sm" onClick={close}>
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
