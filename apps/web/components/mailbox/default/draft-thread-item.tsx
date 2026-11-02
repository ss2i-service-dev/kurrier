"use client";
import { getMessageAddress, getMessageName, avatarName } from "@common/mail-client";
import type { MessageEntity } from "@db";
import { Avatar } from "@mantine/core";
import type { PublicConfig } from "@schema";
import { FileText } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import React, { useRef, useState } from "react";
import { Container } from "@/components/common/containers";
import type { EmailEditorHandle } from "@/components/mailbox/default/editor/email-editor";
import type { FetchIdentityMailboxListResult } from "@/lib/actions/mailbox";
import { DraftSendingBanner } from "@/components/mailbox/default/draft-send-status";

const EmailEditor = dynamic(
	() => import("@/components/mailbox/default/editor/email-editor"),
	{
		ssr: false,
		loading: () => (
			<div className="py-10 text-sm text-muted-foreground">Loading editor…</div>
		),
	},
);

// ss2i : un brouillon s'ouvre dans l'editeur, pre-rempli, a la place du lecteur ; dans
// le fil d'origine (reponse) comme dans le dossier Drafts. Fermer ramene a la liste.
export default function DraftThreadItem({
	draft,
	original,
	publicConfig,
	identityMailboxes,
}: {
	draft: MessageEntity;
	original: MessageEntity | null;
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const editorRef = useRef<EmailEditorHandle>(null);
	const [parked, setParked] = useState(false);
	// Envoi annule (ou etat inconnu) depuis le bandeau : l'editeur normal s'affiche.
	const [released, setReleased] = useState(false);

	const meta = (draft.metaData as any)?.draft ?? {};
	const pendingSend = released ? null : (meta.pendingSend ?? null);
	const sendError = meta.sendError ?? null;
	const mode =
		original && meta.mode === "reply"
			? "reply"
			: original && meta.mode === "forward"
				? "forward"
				: "compose";

	const leave = () => {
		router.push(pathname.replace(/\/threads\/[^/]+\/?$/, ""));
		router.refresh();
	};

	return (
		<Container variant="full" className="!px-2 lg:!px-4">
			<div className={"flex gap-4 p-3"}>
				<div className={"hidden md:block shrink-0 pt-4"}>
					<Avatar
						size="lg"
						radius="xl"
						name={avatarName(
							getMessageName(draft, "from") ||
								getMessageAddress(draft, "from")?.split("@")[0],
						)}
						color="initials"
					/>
				</div>
				<div className={"flex-1 min-w-0"}>
					<div className="flex items-center gap-2 text-sm font-medium text-red-600">
						<FileText size={16} />
						Draft
					</div>
					{pendingSend && !parked && (
						<DraftSendingBanner
							pendingSend={pendingSend}
							onUndone={() => setReleased(true)}
							onOpenEditor={() => setReleased(true)}
						/>
					)}
					{!pendingSend && !parked && sendError && (
						<div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
							Sending failed: {sendError.message}
						</div>
					)}
					{/* Monte meme pendant l'envoi : le composeur qui vient d'envoyer garde son delai « Undo ». */}
					<div className={parked || pendingSend ? "hidden" : undefined}>
						<EmailEditor
							sentMailboxId={""}
							ref={editorRef}
							publicConfig={publicConfig}
							message={original}
							draft={draft}
							identityMailboxes={identityMailboxes}
							onReady={() =>
								requestAnimationFrame(() => editorRef.current?.focus())
							}
							handleClose={leave}
							onParkedChange={setParked}
							showEditorMode={mode}
						/>
					</div>
				</div>
			</div>
		</Container>
	);
}
