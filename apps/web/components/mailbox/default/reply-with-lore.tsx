"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button, Loader, Modal, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useNouvelle } from "@/components/k/ui-context";
import { loreReplyConfig, replyWithLore } from "@/lib/actions/thread-lore";
import { LORE_MAX_INSTRUCTION } from "@common/lore-reply";

// ss2i : « Répondre avec Lore » depuis un fil ouvert (OI 10288), même fenêtre dans les deux
// interfaces. Consigne facultative, puis Lore rédige (jusqu'à 2 minutes, attente visible) ;
// le corps devient un brouillon de réponse du fil, qui s'ouvre dans l'éditeur au
// rafraîchissement du fil. Rien n'est envoyé. La fenêtre peut se fermer pendant la
// rédaction : le brouillon arrive quand même, annoncé par un toast.
// Verrou de saisie (ss2i-shortcuts.js) : la fenêtre est un role="dialog" ; pendant l'attente
// les boutons restent en place (aria-disabled, jamais retirés ni disabled) pour que le focus
// ne tombe pas dans le vide et que les frappes n'aillent pas à un éditeur ouvert derrière.

let config: Promise<{ missing: string[]; message: string | null }> | null = null;
const loadConfig = () => {
	if (!config) config = loreReplyConfig().catch(() => ({ missing: [], message: null }));
	return config;
};

// Interface « Outlook » (<html data-ui="ss2i">) : toast centré, comme add-to-agenda.tsx.
const toastPosition = () =>
	typeof document !== "undefined" && document.documentElement.dataset.ui === "ss2i" ? "bottom-center" : "bottom-left";

export function ReplyWithLore({
	identityPublicId,
	threadId,
	messageId,
	messageLabel,
	trigger,
}: {
	identityPublicId: string | undefined;
	threadId: string;
	/** Message auquel répondre (en-tête d'un message) ; absent : le dernier du fil. */
	messageId?: string;
	/** Expéditeur du message visé, rappelé dans la fenêtre. */
	messageLabel?: string;
	trigger: (open: () => void) => React.ReactNode;
}) {
	const nouvelle = useNouvelle();
	const router = useRouter();
	const [opened, { open, close }] = useDisclosure(false);
	const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");
	const [error, setError] = useState<string | null>(null);
	const [setup, setSetup] = useState<string | null>(null);
	const [instruction, setInstruction] = useState("");
	const [elapsed, setElapsed] = useState(0);
	const busy = useRef(false);
	const openedRef = useRef(false);
	const forThread = useRef(threadId);
	openedRef.current = opened;

	// Un autre fil dans la même barre (nouvelle interface) : la fenêtre repart de zéro ; une
	// rédaction en cours pour l'ancien fil se termine quand même (toast).
	useEffect(() => {
		if (forThread.current === threadId) return;
		forThread.current = threadId;
		setPhase("idle");
		setError(null);
		setInstruction("");
	}, [threadId]);

	useEffect(() => {
		if (phase !== "loading") return;
		const t0 = Date.now();
		setElapsed(0);
		const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
		return () => clearInterval(timer);
	}, [phase]);

	if (!identityPublicId) return null;

	const openDialog = () => {
		open();
		loadConfig().then((c) => setSetup(c.message));
	};

	const submit = async () => {
		if (busy.current || setup) return;
		busy.current = true;
		const thread = threadId;
		setPhase("loading");
		setError(null);
		const res = await replyWithLore({ threadId: thread, identityPublicId, messageId, instruction }).catch((e: any) => ({
			ok: false as const,
			error: String(e?.message ?? e),
		}));
		busy.current = false;
		const here = forThread.current === thread;
		const position = toastPosition();
		if (!res.ok) {
			if (here) {
				setError(res.error);
				setPhase("error");
			}
			// Fenêtre fermée ou autre fil affiché : l'erreur ne passe pas inaperçue.
			if (!here || !openedRef.current) toast.error(`Lore : ${res.error}`, { position });
			return;
		}
		if (here) {
			setPhase("idle");
			setInstruction("");
			close();
		}
		const sources = res.sources.map((s) => s.title || s.url).slice(0, 3);
		toast.success("Brouillon de réponse rédigé par Lore", {
			description: `« ${res.subject} » : relisez-le dans le fil avant de l'envoyer.${sources.length ? ` Sources : ${sources.join(", ")}.` : ""}`,
			position,
		});
		// Le fil se redessine avec le brouillon ouvert dans l'éditeur (DraftThreadItem).
		router.refresh();
	};

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const loading = phase === "loading";

	return (
		<>
			{trigger(openDialog)}
			<Modal opened={opened} onClose={close} size="lg" title="Répondre avec Lore">
				<div className="space-y-3">
					<p className={`text-sm ${muted}`}>
						Lore lit la conversation et rédige une réponse
						{messageLabel ? ` au message de ${messageLabel}` : ""}. Elle est enregistrée en brouillon dans ce fil, à
						votre nom, pour que vous la relisiez : rien n'est envoyé.
					</p>

					{setup && (
						<div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
							{setup}
						</div>
					)}

					<Textarea
						data-autofocus
						label="Consigne pour Lore (facultative)"
						description="Ctrl+Entrée lance la rédaction."
						placeholder="Ex. : accepter le rendez-vous de mardi, proposer jeudi 10 h à la place, ton cordial."
						autosize
						minRows={3}
						maxRows={10}
						maxLength={LORE_MAX_INSTRUCTION}
						value={instruction}
						readOnly={loading}
						onChange={(e) => setInstruction(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								void submit();
							}
						}}
					/>

					{loading && (
						<div className={`flex items-start gap-2 text-sm ${muted}`} role="status">
							<Loader size="sm" />
							<div>
								<div>Lore rédige la réponse… {elapsed} s</div>
								<div className="text-xs">
									Cela peut prendre jusqu'à 2 minutes. Vous pouvez fermer cette fenêtre : le brouillon apparaîtra dans le
									fil.
								</div>
							</div>
						</div>
					)}

					{error && (
						<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
							{error}
						</div>
					)}

					<div className="flex justify-end gap-2 pt-1">
						<Button variant="default" size="sm" onClick={close}>
							{loading ? "Fermer" : "Annuler"}
						</Button>
						{/* Pas de disabled : un bouton désactivé perd le focus (voir plus haut). */}
						<Button
							size="sm"
							onClick={() => void submit()}
							aria-disabled={loading || !!setup}
							data-disabled={loading || !!setup || undefined}
						>
							{loading ? "Rédaction en cours…" : phase === "error" ? "Réessayer" : "Rédiger le brouillon"}
						</Button>
					</div>
				</div>
			</Modal>
		</>
	);
}
