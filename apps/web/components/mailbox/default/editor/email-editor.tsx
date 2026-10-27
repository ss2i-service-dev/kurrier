"use client";
import React, {
	useEffect,
	useRef,
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
import type { FormState, PublicConfig } from "@schema";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { toast } from "sonner";
import { useParams } from "next/navigation";

export type EmailEditorHandle = {
	focus: () => void;
	getElement: () => HTMLElement | null;
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
};

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
		},
		ref,
	) => {
		const textEditorRef = useRef<TextEditorHandle>(null);

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
				}
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
				toast.error("Error", {
					description: formState.error,
				});
			} else if (formState.success) {
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
				<div className={"mt-4"} tabIndex={-1}>
					<DynamicContextProvider
						initialState={{ isPending, message, publicConfig, showEditorMode, identityMailboxes, signatureHtml}}
						syncOnChange
					>
						<Form action={formAction}>
							<input
								type={"hidden"}
								name={"messageMailboxId"}
								value={message?.mailboxId}
							/>
							<TextEditor name={"html"} ref={textEditorRef} />
						</Form>
					</DynamicContextProvider>
				</div>
			</>
		);
	},
);

EmailEditor.displayName = "EmailEditor";
export default EmailEditor;
