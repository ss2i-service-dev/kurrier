"use client";
import { draftTimesOf } from "@common/draft-send";

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

// Draft state exposed in the editor footer (indicator, Save draft, Discard).
export type DraftStatus = {
	state: "idle" | "saving" | "saved" | "error";
	savedAt?: Date;
	// Draft creation (first save).
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
	// Hides (true) or shows again (false) the composer without destroying it, for the
	// duration of the send-undo window. Without it, the composer closes on send.
	onParkedChange?: (parked: boolean) => void;
	// Resumed draft (`messages` row of the Drafts folder); the editor starts from it
	// and keeps saving it.
	draft?: MessageEntity | null;
};

// Autosave: the database follows typing within 3 s (the slower IMAP version is the
// worker's job). The form reflects the whole editor state through its hidden fields:
// it is read back as is, once per second, and compared.
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
		const textEditorRef = useRef<TextEditorHandle>(null);
		const formRef = useRef<HTMLFormElement>(null);
		const router = useRouter();

		useImperativeHandle(
			ref,
			() => ({
				// A marked recipient field (new message, forward) comes before the body;
				// a reply goes straight to the body.
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

		useEffect(() => {
			const el = textEditorRef.current?.getElement();
			if (el) onReady?.(el);
		}, [onReady]);

		const params = useParams() as { identityPublicId?: string };
		// The user's RFC style, for the reply quote preview.
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

		// The composer stays alive (hidden) during the undo window, so that "Undo"
		// brings it back intact: recipients, subject, text, attachments.
		const mounted = useRef(true);
		useEffect(() => {
			mounted.current = true;
			return () => {
				mounted.current = false;
			};
		}, []);

		// --- draft ---------------------------------------------------------------
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
		// Resumed draft: the first read (editor rendered) is the saved state.
		const baseline = useRef(!!draft);
		// Sending in progress or draft discarded: no more saving.
		const suspended = useRef(false);
		const chain = useRef<Promise<void>>(Promise.resolve());
		const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
		const submittedDraftId = useRef<string | null>(null);
		// Last read of the form: on unmount, the ref is already detached.
		const latest = useRef<ReturnType<typeof readForm> | null>(null);
		const snapshot = () => {
			const form = formRef.current;
			if (form) latest.current = readForm(form);
			return latest.current;
		};

		// Local copy of the draft (lib/draft-backup.ts), written on every keystroke and
		// independent of the server. It is only removed after a successful send or on discard.
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

		// Server save failure: the alert stays, and the browser asks for confirmation
		// before leaving the page until the server has the latest version.
		const saveFailed = useRef(false);
		const notifySaveError = (message: string) => {
			saveFailed.current = true;
			backupNow();
			const skew = /server action|older or newer deployment|failed to fetch|unexpected/i.test(
				message,
			);
			toast.error("Draft NOT saved on the server", {
				id: "kurrier-draft-save-error",
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
			toast.dismiss("kurrier-draft-save-error");
		};

		const persist = useCallback((flush = false) => {
			const snap = snapshot();
			if (!snap) return chain.current;
			const run = async () => {
				if (suspended.current) return;
				const { payload, key, empty } = snap;
				if (!payload.identityPublicId) return;
				if (baseline.current) {
					// Resumed draft, nothing read yet: this is the saved state.
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
				// Nothing to keep while the editor is empty.
				if (empty && !draftIdRef.current) return;
				setDraftStatus((prev) => ({ state: "saving", createdAt: prev.createdAt }));
				const res = await saveDraft({ ...payload, draftMessageId: draftIdRef.current });
				if (!res?.draftMessageId) {
					const error = res?.error ?? "Draft could not be saved.";
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
			// Saves of the same draft run one after another, never two at once.
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
			// Tab or editor closing: whatever is left is saved right away.
			const onHide = () => {
				backupNow();
				void persist(true);
			};
			// Server failing: browser confirmation before leaving the page.
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
			toast.dismiss("kurrier-draft-save-error");
			saveFailed.current = false;
			toast.success("Draft discarded", { position: "bottom-left" });
			// discardDraft revalidates the pages (Drafts counter, list); a router.refresh()
			// here would cancel handleClose's navigation when the draft is open as a page.
			handleClose();
		}, [handleClose, params.identityPublicId]);

		const draftContext: DraftContext = {
			id: draftId,
			status: draftStatus,
			save: () => persist(true),
			discard,
		};

		const onFormSubmit = () => {
			// Sending takes the draft as known to the form; nothing more to save.
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
			// Safety net if the composer disappeared in the meantime (navigation): the
			// text is copied to the clipboard on "Undo".
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
					// The local copy becomes recoverable again.
					markSent(null);
					toast.error("Sending failed", {
						description: result.error,
						position: "bottom-left",
					});
					// The draft's "Not sent" badge.
					router.refresh();
					return;
				}
				dropBackup();
				// The sent draft leaves the Drafts folder: refresh.
				router.refresh();
			};
			// Undo disabled in Settings > Composing: send directly, without the undo toast.
			if (undoMs <= 0) {
				const toastId = toast.loading("Sending…", { position: "bottom-left" });
				settled = true;
				if (mounted.current) handleClose();
				void waitPendingSend(pendingSendId).then((result) => {
					if (result?.error) {
						markSent(null);
						toast.error("Sending failed", {
							id: toastId,
							description: result.error,
							position: "bottom-left",
						});
					} else {
						dropBackup();
						toast.success("Sent", { id: toastId, position: "bottom-left" });
					}
					router.refresh();
				});
				return;
			}
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
							// Send cancelled: the draft resumes.
							suspended.current = false;
							markSent(null);
							requestAnimationFrame(() => textEditorRef.current?.focus("end"));
							toast.success("Sending cancelled", { position: "bottom-left" });
						} else {
							// Editor closed: the local copy goes to Drafts (DraftBackupRecovery).
							markSent(null);
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
				markSent(null);
				toast.error("Error", {
					description: formState.error,
				});
			} else if (formState.success) {
				// A save still in flight at send time would have created a draft the send
				// job does not know about: remove it.
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
				toast.success("Success", {
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
