"use client";
import { getMessageAddress, getMessageName } from "@common/mail-client";
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

	const meta = (draft.metaData as any)?.draft ?? {};
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
		<Container variant="wide">
			<div className={"grid grid-cols-12 p-3"}>
				<div className={"hidden md:block md:col-span-1 pt-4"}>
					<Avatar
						size="lg"
						radius="xl"
						name={
							getMessageName(draft, "from") ||
							getMessageAddress(draft, "from") ||
							""
						}
						color="initials"
					/>
				</div>
				<div className={"col-span-12 md:col-span-11"}>
					<div className="flex items-center gap-2 text-sm font-medium text-red-600">
						<FileText size={16} />
						Draft
					</div>
					<div className={parked ? "hidden" : undefined}>
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
