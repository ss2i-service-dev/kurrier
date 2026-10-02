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
import {FetchIdentityMailboxListResult, sendMail} from "@/lib/actions/mailbox";
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
			identityMailboxes
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

		useEffect(() => {
			if (formState.error) {
				toast.error("Error", {
					description: formState.error,
				});
			} else if (formState.success) {
				handleClose();
				toast.success("Success", {
					description: formState.success,
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
