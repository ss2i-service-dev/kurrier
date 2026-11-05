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
import { useModernUi } from "@/components/k/ui-context";

const EmailEditor = dynamic(
	() => import("@/components/mailbox/default/editor/email-editor"),
	{
		ssr: false,
		loading: () => (
			<div className="py-10 text-sm text-muted-foreground">Loading editor…</div>
		),
	},
);

// A draft opens in the editor, pre-filled, in place of the reader; in the original thread
// (reply) as well as in the Drafts folder. Closing goes back to the list.
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
	const modern = useModernUi();
	const editorRef = useRef<EmailEditorHandle>(null);
	const [parked, setParked] = useState(false);
	// Send canceled (or unknown state) from the banner: the regular editor is shown.
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

	// No router.refresh() here: run right after, it canceled the navigation to the list (the
	// RSC request of router.push was aborted) and the editor stayed displayed after
	// "Discard". The list, a dynamic page, is reloaded by the navigation; actions that change
	// the counters (discardDraft) revalidate on the server.
	const leave = () => {
		const listUrl = pathname.replace(/\/threads\/[^/]+\/?$/, "");
		// Modern interface: the list is already displayed alongside, so only the URL changes
		// (no new server render, no skeleton).
		if (modern) {
			window.history.pushState(null, "", listUrl);
			return;
		}
		router.push(listUrl);
	};

	// Modern interface: same content in a plain frame (a "Draft" label and the editor as a
	// card) in place of the avatar and the red title.
	if (modern) {
		return (
			<div>
				<div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.05em] text-k-warn">
					<FileText size={13} />
					Draft
				</div>
				{pendingSend && !parked && (
					<DraftSendingBanner pendingSend={pendingSend} onUndone={() => setReleased(true)} onOpenEditor={() => setReleased(true)} />
				)}
				{!pendingSend && !parked && sendError && (
					<div className="mb-3 rounded-k bg-k-danger-soft px-3 py-2 text-[13px] text-k-danger">
						Sending failed: {sendError.message}
					</div>
				)}
				<div className={parked || pendingSend ? "hidden" : "overflow-hidden rounded-k-pane border border-k-line bg-k-surface"}>
					<EmailEditor
						sentMailboxId={""}
						ref={editorRef}
						publicConfig={publicConfig}
						message={original}
						draft={draft}
						identityMailboxes={identityMailboxes}
						onReady={() => requestAnimationFrame(() => editorRef.current?.focus())}
						handleClose={leave}
						onParkedChange={setParked}
						showEditorMode={mode}
					/>
				</div>
			</div>
		);
	}

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
					{/* Mounted even during the send: the composer that just sent keeps its "Undo" delay. */}
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
