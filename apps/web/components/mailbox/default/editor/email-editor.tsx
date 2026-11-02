"use client";
import React, {
	useCallback,
	useEffect,
	useRef,
	useState,
	forwardRef,
	useImperativeHandle,
	useActionState,
} from "react";
import { MessageEntity } from "@db";
import {
	TextEditor,
	TextEditorHandle,
} from "@/components/mailbox/default/editor/rich-text-editor";
import Form from "next/form";
import {
	FetchIdentityMailboxListResult,
	cancelPendingSend,
	sendMail,
	sendPendingNow,
	waitPendingSend,
} from "@/lib/actions/mailbox";
import { discardDraft, flushDraft, saveDraft } from "@/lib/actions/drafts";
import type { FormState, PublicConfig } from "@schema";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { toast } from "sonner";
import { useParams, useRouter } from "next/navigation";
import { useRfcStyle } from "@/components/mailbox/default/compose-style-context";

export type EmailEditorHandle = {
	focus: () => void;
	getElement: () => HTMLElement | null;
};

// ss2i : etat du brouillon expose au pied de l'editeur (indicateur, Save draft, Discard).
export type DraftStatus = {
	state: "idle" | "saving" | "saved" | "error";
	savedAt?: Date;
	error?: string;
};
export type DraftContext = {
	id: string | null;
	status: DraftStatus;
	save: () => Promise<void>;
	discard: () => Promise<void>;
};

type Props = {
	onReady?: (el: HTMLElement) => void;
	message: MessageEntity | null;
	publicConfig: PublicConfig;
	showEditorMode: string;
	sentMailboxId: string;
	handleClose: () => void;
	identityMailboxes: FetchIdentityMailboxListResult;
	// ss2i : masque (true) ou reaffiche (false) le composeur sans le detruire, le temps
	// de la fenetre d'annulation d'envoi. Sans elle, le composeur se ferme a l'envoi.
	onParkedChange?: (parked: boolean) => void;
	// ss2i : brouillon repris (ligne `messages` du dossier Drafts) ; l'editeur en part et
	// continue de l'enregistrer.
	draft?: MessageEntity | null;
};

// Enregistrement automatique : la base suit la frappe a 3 s pres (la version IMAP, plus
// lente, est du ressort du worker). Le formulaire reflete tout l'etat de l'editeur par ses
// champs caches : on le relit tel quel, une fois par seconde, et on compare.
const DRAFT_DEBOUNCE_MS = 3_000;
const DRAFT_POLL_MS = 1_000;

function readForm(form: HTMLFormElement) {
	const fd = new FormData(form);
	const str = (k: string) => String(fd.get(k) ?? "");
	const payload = {
		identityPublicId: str("identityPublicId"),
		to: str("to"),
		cc: str("cc"),
		bcc: str("bcc"),
		subject: str("subject"),
		html: str("html"),
		text: str("text"),
		mode: str("mode"),
		originalMessageId: str("originalMessageId") || null,
		attachments: str("attachments"),
		includeSignature: str("includeSignature"),
		quoteScope: str("quoteScope") || null,
	};
	const empty =
		!payload.to.trim() &&
		!payload.cc.trim() &&
		!payload.bcc.trim() &&
		!payload.subject.trim() &&
		!payload.text.trim() &&
		(payload.attachments === "" || payload.attachments === "[]");
	const key = JSON.stringify([
		payload.identityPublicId,
		payload.to,
		payload.cc,
		payload.bcc,
		payload.subject,
		payload.html,
		payload.attachments,
		payload.includeSignature,
		payload.quoteScope,
	]);
	return { payload, key, empty };
}

const EmailEditor = forwardRef<EmailEditorHandle, Props>(
	(
		{
			onReady,
			message,
			publicConfig,
			showEditorMode,
			sentMailboxId,
			handleClose,
			identityMailboxes,
			onParkedChange,
			draft = null,
		},
		ref,
	) => {
		const textEditorRef = useRef<TextEditorHandle>(null);
		const formRef = useRef<HTMLFormElement>(null);
		const router = useRouter();

		useImperativeHandle(
			ref,
			() => ({
				focus: () => textEditorRef.current?.focus("end"),
				getElement: () => textEditorRef.current?.getElement() ?? null,
			}),
			[],
		);

		useEffect(() => {
			const el = textEditorRef.current?.getElement();
			if (el) onReady?.(el);
		}, [onReady]);

		const params = useParams() as { identityPublicId?: string };
		// ss2i : style RFC de l'utilisateur, pour l'apercu de la citation en reponse.
		const rfcStyle = useRfcStyle();
		const signatureHtml = React.useMemo(() => {
			const entry = (identityMailboxes ?? []).find(
				(im) => im.identity.publicId === params.identityPublicId,
			);
			return String((entry?.identity?.metaData as any)?.signatureHtml ?? "");
		}, [identityMailboxes, params.identityPublicId]);

		const [formState, formAction, isPending] = useActionState<
			FormState,
			FormData
		>(sendMail, {});

		// ss2i : le composeur reste en vie (masque) pendant la fenetre d'annulation, pour
		// que « Undo » le rende intact : destinataires, objet, texte, pieces jointes.
		const mounted = useRef(true);
		useEffect(() => {
			mounted.current = true;
			return () => {
				mounted.current = false;
			};
		}, []);

		// --- brouillon ---------------------------------------------------------------
		const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
		const draftIdRef = useRef<string | null>(draft?.id ?? null);
		const [draftStatus, setDraftStatus] = useState<DraftStatus>(
			draft ? { state: "saved", savedAt: draft.date ?? undefined } : { state: "idle" },
		);
		const lastSavedKey = useRef<string | null>(null);
		const seenKey = useRef<string | null>(null);
		// Brouillon repris : le premier releve (editeur rendu) est l'etat enregistre.
		const baseline = useRef(!!draft);
		// Envoi en cours ou brouillon abandonne : plus d'enregistrement.
		const suspended = useRef(false);
		const chain = useRef<Promise<void>>(Promise.resolve());
		const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
		const submittedDraftId = useRef<string | null>(null);
		// Dernier releve du formulaire : au demontage, le ref est deja detache.
		const latest = useRef<ReturnType<typeof readForm> | null>(null);
		const snapshot = () => {
			const form = formRef.current;
			if (form) latest.current = readForm(form);
			return latest.current;
		};

		const persist = useCallback((flush = false) => {
			const snap = snapshot();
			if (!snap) return chain.current;
			const run = async () => {
				if (suspended.current) return;
				const { payload, key, empty } = snap;
				if (!payload.identityPublicId) return;
				if (baseline.current) {
					// Brouillon repris, rien n'a encore ete releve : c'est l'etat enregistre.
					baseline.current = false;
					lastSavedKey.current = key;
					seenKey.current = key;
					return;
				}
				if (key === lastSavedKey.current) {
					if (flush && draftIdRef.current) {
						await flushDraft(payload.identityPublicId, draftIdRef.current);
					}
					return;
				}
				// Rien a garder tant que l'editeur est vide.
				if (empty && !draftIdRef.current) return;
				setDraftStatus({ state: "saving" });
				const res = await saveDraft({ ...payload, draftMessageId: draftIdRef.current });
				if (!res.draftMessageId) {
					setDraftStatus({ state: "error", error: res.error ?? "Draft could not be saved." });
					return;
				}
				const savedId = res.draftMessageId;
				draftIdRef.current = savedId;
				setDraftId(savedId);
				lastSavedKey.current = key;
				setDraftStatus({
					state: "saved",
					savedAt: res.savedAt ? new Date(res.savedAt) : new Date(),
				});
				if (flush) await flushDraft(payload.identityPublicId, savedId);
			};
			// Les enregistrements d'un meme brouillon se suivent, jamais deux a la fois.
			chain.current = chain.current.then(run).catch((e: any) => {
				setDraftStatus({ state: "error", error: String(e?.message ?? e) });
			});
			return chain.current;
		}, []);

		useEffect(() => {
			const tick = () => {
				if (suspended.current) return;
				const snap = snapshot();
				if (!snap) return;
				const { key } = snap;
				if (baseline.current) {
					baseline.current = false;
					lastSavedKey.current = key;
					seenKey.current = key;
					return;
				}
				if (key === seenKey.current) return;
				seenKey.current = key;
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					timer.current = null;
					void persist(false);
				}, DRAFT_DEBOUNCE_MS);
			};
			const interval = setInterval(tick, DRAFT_POLL_MS);
			// Fermeture de l'onglet ou de l'editeur : ce qui reste part tout de suite.
			const onHide = () => void persist(true);
			window.addEventListener("pagehide", onHide);
			return () => {
				clearInterval(interval);
				window.removeEventListener("pagehide", onHide);
				if (timer.current) clearTimeout(timer.current);
				void persist(true);
			};
		}, [persist]);

		const discard = useCallback(async () => {
			suspended.current = true;
			if (timer.current) clearTimeout(timer.current);
			await chain.current.catch(() => {});
			const id = draftIdRef.current;
			if (id && params.identityPublicId) {
				const res = await discardDraft(params.identityPublicId, id);
				if (res && "error" in res && res.error) {
					toast.error(res.error);
					suspended.current = false;
					return;
				}
			}
			toast.success("Draft discarded", { position: "bottom-left" });
			handleClose();
			router.refresh();
		}, [handleClose, params.identityPublicId, router]);

		const draftContext: DraftContext = {
			id: draftId,
			status: draftStatus,
			save: () => persist(true),
			discard,
		};

		const onFormSubmit = () => {
			// L'envoi emporte le brouillon tel que connu du formulaire ; plus rien a enregistrer.
			suspended.current = true;
			if (timer.current) clearTimeout(timer.current);
			submittedDraftId.current = draftIdRef.current;
		};

		const onKeyDown = (e: React.KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void persist(true);
			}
		};
		// -------------------------------------------------------------------------------

		const startUndoWindow = (pendingSendId: string, undoMs: number) => {
			// Filet si le composeur a disparu entre-temps (navigation) : le texte est
			// recopie dans le presse-papiers au moment de « Undo ».
			const bodyText = textEditorRef.current?.getElement()?.innerText ?? "";
			onParkedChange ? onParkedChange(true) : handleClose();

			let settled = false;
			const finish = async () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				toast.dismiss(toastId);
				if (mounted.current) handleClose();
				const result = await waitPendingSend(pendingSendId);
				if (result?.error) {
					toast.error("Sending failed", {
						description: result.error,
						position: "bottom-left",
					});
					return;
				}
				// Le brouillon envoye disparait du dossier Drafts : on rafraichit.
				if (submittedDraftId.current) router.refresh();
			};
			const timer = setTimeout(finish, undoMs);

			const toastId = toast("Sending…", {
				position: "bottom-left",
				duration: undoMs,
				description: "You can still undo",
				action: {
					label: "Send now",
					onClick: () => {
						sendPendingNow(pendingSendId).then(finish);
					},
				},
				cancel: {
					label: "Undo",
					onClick: async () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						const { cancelled } = await cancelPendingSend(pendingSendId);
						if (!cancelled) {
							toast.info("Already sent", { position: "bottom-left" });
							if (mounted.current) handleClose();
							return;
						}
						if (mounted.current) {
							onParkedChange?.(false);
							// Envoi annule : le brouillon reprend son cours.
							suspended.current = false;
							requestAnimationFrame(() => textEditorRef.current?.focus("end"));
							toast.success("Sending cancelled", { position: "bottom-left" });
						} else {
							await navigator.clipboard?.writeText(bodyText).catch(() => {});
							toast.warning("Sending cancelled", {
								description: "The editor was closed: its text has been copied to the clipboard.",
								position: "bottom-left",
							});
						}
					},
				},
			});
		};

		useEffect(() => {
			if (formState.error) {
				suspended.current = false;
				toast.error("Error", {
					description: formState.error,
				});
			} else if (formState.success) {
				// Un enregistrement encore en vol au moment de l'envoi aurait cree un brouillon
				// que le job d'envoi ne connait pas : on le retire.
				const submitted = submittedDraftId.current;
				void chain.current.then(() => {
					const id = draftIdRef.current;
					if (id && id !== submitted && params.identityPublicId) {
						void discardDraft(params.identityPublicId, id);
					}
				});
				const pending = (formState.data ?? {}) as {
					pendingSendId?: string;
					undoMs?: number;
				};
				if (pending.pendingSendId) {
					startUndoWindow(pending.pendingSendId, pending.undoMs ?? 30_000);
					return;
				}
				handleClose();
				toast.success("Success", {
					description: formState.message,
				});
			}
		}, [formState]);


		return (
			<>
				<div className={"mt-4"} tabIndex={-1} onKeyDown={onKeyDown}>
					<DynamicContextProvider
						initialState={{
							isPending,
							message,
							publicConfig,
							showEditorMode,
							identityMailboxes,
							signatureHtml,
							rfcStyle,
							draftRow: draft,
							draft: draftContext,
						}}
						syncOnChange
					>
						<Form action={formAction} ref={formRef} onSubmit={onFormSubmit}>
							<input
								type={"hidden"}
								name={"messageMailboxId"}
								value={message?.mailboxId}
							/>
							<input type="hidden" name="draftMessageId" value={draftId ?? ""} />
							<TextEditor
								name={"html"}
								ref={textEditorRef}
								defaultValue={draft?.html ?? ""}
							/>
						</Form>
					</DynamicContextProvider>
				</div>
			</>
		);
	},
);

EmailEditor.displayName = "EmailEditor";
export default EmailEditor;
