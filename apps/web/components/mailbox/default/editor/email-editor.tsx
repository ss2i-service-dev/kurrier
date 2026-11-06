"use client";
import { draftTimesOf } from "@common/draft-send";
import { useK } from "@/components/k/ui-context";
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
import {
	newBackupId,
	patchBackup,
	removeBackup,
	touchAlive,
	writeBackup,
} from "@/lib/draft-backup";

export type EmailEditorHandle = {
	focus: () => void;
	getElement: () => HTMLElement | null;
};

// ss2i : etat du brouillon expose au pied de l'editeur (indicateur, Save draft, Discard).
export type DraftStatus = {
	state: "idle" | "saving" | "saved" | "error";
	savedAt?: Date;
	// ss2i : creation du brouillon (premier enregistrement).
	createdAt?: Date;
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
		quoteMode: str("quoteMode") || null,
		quoteHtml: str("quoteHtml") || null,
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
		payload.quoteMode,
		payload.quoteHtml,
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
		const t = useK(); // ss2i : francais dans la nouvelle interface
		const textEditorRef = useRef<TextEditorHandle>(null);
		const formRef = useRef<HTMLFormElement>(null);
		const router = useRouter();

		useImperativeHandle(
			ref,
			() => ({
				// ss2i : un champ destinataire marque (nouveau message, transfert) passe
				// avant le corps ; une reponse va directement dans le corps.
				focus: () => {
					const el = formRef.current?.querySelector<HTMLElement>('[data-k-autofocus="true"]');
					const input = el && (el.matches("input") ? el : el.querySelector<HTMLElement>("input"));
					if (input) input.focus();
					else textEditorRef.current?.focus("end");
				},
				getElement: () => textEditorRef.current?.getElement() ?? null,
			}),
			[],
		);

		// ss2i : onReady une seule fois, a l'ouverture de l'editeur. Les appelants passent une
		// fonction flechee recreee a chaque rendu : l'effet sur [onReady] se rejouait a chaque
		// rendu du parent (sauvegarde du brouillon, saisie dans le message transfere) et
		// remettait le curseur sur « A » pendant qu'on supprimait du texte transfere
		// (Samuel le 06/11 : « quand je supprime, ça me met dans la zone de saisie de destinataire »).
		const onReadyRef = useRef(onReady);
		onReadyRef.current = onReady;
		const readyDoneRef = useRef(false);
		useEffect(() => {
			if (readyDoneRef.current) return;
			const el = textEditorRef.current?.getElement();
			if (!el) return;
			readyDoneRef.current = true;
			onReadyRef.current?.(el);
		});

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
			draft
				? (() => {
						const times = draftTimesOf(draft);
						return {
							state: "saved" as const,
							savedAt: times.savedAt ? new Date(times.savedAt) : (draft.date ?? undefined),
							createdAt: times.createdAt ? new Date(times.createdAt) : undefined,
						};
					})()
				: { state: "idle" },
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

		// ss2i : copie locale du brouillon (lib/draft-backup.ts), ecrite a chaque frappe et
		// independante du serveur. Elle n'est retiree qu'a l'envoi abouti ou a l'abandon.
		const backupId = useRef<string>(newBackupId());
		const backupOff = useRef(false);
		const sentAt = useRef<number | null>(null);
		const lastBackup = useRef<string | null>(null);
		const backupNow = () => {
			if (backupOff.current) return;
			const snap = snapshot();
			if (!snap) return;
			const { payload, key, empty } = snap;
			if (!payload.identityPublicId) return;
			if (empty && !draftIdRef.current) return;
			const sig = JSON.stringify([key, lastSavedKey.current, draftIdRef.current, sentAt.current]);
			if (sig === lastBackup.current) return;
			const ok = writeBackup({
				v: 1,
				id: backupId.current,
				identityPublicId: payload.identityPublicId,
				draftMessageId: draftIdRef.current,
				payload: payload as Record<string, string | null>,
				key,
				savedKey: lastSavedKey.current,
				sentAt: sentAt.current,
				updatedAt: Date.now(),
			});
			if (ok) lastBackup.current = sig;
			touchAlive(backupId.current);
		};
		const dropBackup = () => {
			backupOff.current = true;
			removeBackup(backupId.current);
		};
		const markSent = (at: number | null) => {
			sentAt.current = at;
			backupNow();
			patchBackup(backupId.current, { sentAt: at });
		};

		// Echec d'enregistrement serveur : alerte qui reste, et le navigateur demande
		// confirmation avant de quitter la page tant que le serveur n'a pas la derniere version.
		const saveFailed = useRef(false);
		const notifySaveError = (message: string) => {
			saveFailed.current = true;
			backupNow();
			const skew = /server action|older or newer deployment|failed to fetch|unexpected/i.test(
				message,
			);
			toast.error("Draft NOT saved on the server", {
				id: "ss2i-draft-save-error",
				duration: Infinity,
				position: "bottom-left",
				description: skew
					? "The app was updated or restarted. Your text is kept in this browser: reload the page, it will be put back in Drafts automatically."
					: `${message} Your text is kept in this browser and will be put back in Drafts after a reload.`,
				action: skew
					? {
							label: "Reload",
							onClick: () => {
								backupNow();
								saveFailed.current = false;
								window.location.reload();
							},
						}
					: undefined,
			});
		};
		const notifySaveOk = () => {
			if (!saveFailed.current) return;
			saveFailed.current = false;
			toast.dismiss("ss2i-draft-save-error");
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
				setDraftStatus((prev) => ({ state: "saving", createdAt: prev.createdAt }));
				const res = await saveDraft({ ...payload, draftMessageId: draftIdRef.current });
				if (!res?.draftMessageId) {
					const error = res?.error ?? t("Draft could not be saved.", "Le brouillon n'a pas pu être enregistré.");
					setDraftStatus((prev) => ({ state: "error", error, createdAt: prev.createdAt }));
					notifySaveError(error);
					return;
				}
				const savedId = res.draftMessageId;
				draftIdRef.current = savedId;
				setDraftId(savedId);
				lastSavedKey.current = key;
				notifySaveOk();
				backupNow();
				setDraftStatus((prev) => ({
					state: "saved",
					savedAt: res.savedAt ? new Date(res.savedAt) : new Date(),
					createdAt: res.createdAt ? new Date(res.createdAt) : prev.createdAt,
				}));
				if (flush) await flushDraft(payload.identityPublicId, savedId);
			};
			// Les enregistrements d'un meme brouillon se suivent, jamais deux a la fois.
			chain.current = chain.current.then(run).catch((e: any) => {
				const error = String(e?.message ?? e);
				setDraftStatus((prev) => ({ state: "error", error, createdAt: prev.createdAt }));
				notifySaveError(error);
			});
			return chain.current;
		}, []);

		useEffect(() => {
			const tick = () => {
				if (!backupOff.current) touchAlive(backupId.current);
				if (suspended.current) return;
				backupNow();
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
			const onHide = () => {
				backupNow();
				void persist(true);
			};
			// Serveur en echec : confirmation du navigateur avant de quitter la page.
			const onBeforeUnload = (e: BeforeUnloadEvent) => {
				backupNow();
				if (!saveFailed.current || backupOff.current) return;
				e.preventDefault();
				e.returnValue = "";
			};
			window.addEventListener("pagehide", onHide);
			window.addEventListener("beforeunload", onBeforeUnload);
			return () => {
				clearInterval(interval);
				window.removeEventListener("pagehide", onHide);
				window.removeEventListener("beforeunload", onBeforeUnload);
				backupNow();
				if (timer.current) clearTimeout(timer.current);
				void persist(true);
			};
		}, [persist]);

		const discard = useCallback(async () => {
			suspended.current = true;
			backupOff.current = true;
			if (timer.current) clearTimeout(timer.current);
			await chain.current.catch(() => {});
			const id = draftIdRef.current;
			if (id && params.identityPublicId) {
				const res = await discardDraft(params.identityPublicId, id);
				if (res && "error" in res && res.error) {
					toast.error(res.error);
					suspended.current = false;
					backupOff.current = false;
					return;
				}
			}
			dropBackup();
			toast.dismiss("ss2i-draft-save-error");
			saveFailed.current = false;
			toast.success(t("Draft discarded", "Brouillon supprimé"), { position: "bottom-left" });
			// discardDraft revalide les pages (compteur Drafts, liste) ; un router.refresh()
			// ici annulerait la navigation de handleClose quand le brouillon est ouvert en page.
			handleClose();
		}, [handleClose, params.identityPublicId]);

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
			markSent(Date.now());
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
					// La copie locale redevient recuperable.
					markSent(null);
					toast.error(t("Sending failed", "L'envoi a échoué"), {
						description: result.error,
						position: "bottom-left",
					});
					// Le badge « Not sent » du brouillon.
					router.refresh();
					return;
				}
				dropBackup();
				// Le brouillon envoye disparait du dossier Drafts : on rafraichit.
				router.refresh();
			};
			// Annulation desactivee (Parametres > Redaction) : envoi direct, sans toast.
			if (undoMs <= 0) {
				const toastId = toast.loading(t("Sending…", "Envoi…"), { position: "bottom-left" });
				settled = true;
				if (mounted.current) handleClose();
				void waitPendingSend(pendingSendId).then((result) => {
					if (result?.error) {
						markSent(null);
						toast.error(t("Sending failed", "L'envoi a échoué"), {
							id: toastId,
							description: result.error,
							position: "bottom-left",
						});
					} else {
						dropBackup();
						toast.success(t("Sent", "Envoyé"), { id: toastId, position: "bottom-left" });
					}
					router.refresh();
				});
				return;
			}
			const timer = setTimeout(finish, undoMs);

			const toastId = toast(t("Sending…", "Envoi…"), {
				position: "bottom-left",
				duration: undoMs,
				description: t("You can still undo", "Vous pouvez encore annuler"),
				action: {
					label: t("Send now", "Envoyer maintenant"),
					onClick: () => {
						sendPendingNow(pendingSendId).then(finish);
					},
				},
				cancel: {
					label: t("Undo", "Annuler"),
					onClick: async () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						const { cancelled } = await cancelPendingSend(pendingSendId);
						if (!cancelled) {
							toast.info(t("Already sent", "Déjà envoyé"), { position: "bottom-left" });
							if (mounted.current) handleClose();
							return;
						}
						if (mounted.current) {
							onParkedChange?.(false);
							// Envoi annule : le brouillon reprend son cours.
							suspended.current = false;
							markSent(null);
							requestAnimationFrame(() => textEditorRef.current?.focus("end"));
							toast.success(t("Sending cancelled", "Envoi annulé"), { position: "bottom-left" });
						} else {
							// Editeur ferme : la copie locale part dans Drafts (DraftBackupRecovery).
							markSent(null);
							await navigator.clipboard?.writeText(bodyText).catch(() => {});
							toast.warning(t("Sending cancelled", "Envoi annulé"), {
								description: t("The editor was closed: its text has been copied to the clipboard.", "L'éditeur était fermé : son texte a été copié dans le presse-papiers."),
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
				markSent(null);
				toast.error(t("Error", "Erreur"), {
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
				dropBackup();
				handleClose();
				toast.success(t("Success", "Envoyé"), {
					description: formState.message,
				});
			}
		}, [formState]);


		return (
			<>
				<div
					className={"mt-4"}
					onKeyDown={onKeyDown}
					onInput={() => backupNow()}
					onKeyUp={() => backupNow()}
				>
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
