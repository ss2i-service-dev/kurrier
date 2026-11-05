"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, PencilLine } from "lucide-react";
import EmailEditor, {
	EmailEditorHandle,
} from "@/components/mailbox/default/editor/email-editor";
import { PublicConfig } from "@schema";
import {FetchIdentityMailboxListResult, fetchMailbox} from "@/lib/actions/mailbox";
import { useParams, useRouter } from "next/navigation";
import { closeCompose, openCompose, setComposeParked, useMailStore } from "@/components/k/mail-store";
import { useMediaQuery } from "@mantine/hooks";
import { useShortcutHint } from "@/components/k/shortcuts-config";

function Portal({ children }: { children: React.ReactNode }) {
	const elRef = useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState(false);

	if (!elRef.current) elRef.current = document.createElement("div");

	useEffect(() => {
		const el = elRef.current!;
		document.body.appendChild(el);
		setMounted(true);
		return () => {
			document.body.removeChild(el);
		};
	}, []);

	return mounted ? createPortal(children, elRef.current!) : null;
}

// New message in the reading pane (desktop) or full screen (mobile). During the
// undo window of a send, the editor stays mounted but hidden ("parked"), as in
// compose-mail.tsx.
export default function KCompose({
	publicConfig,
	identityMailboxes,
}: {
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
}) {
	// Mobile: local full-screen window. Desktop: the new message takes over the
	// reading pane (shared state in components/k/mail-store).
	const [mobileOpen, setMobileOpen] = useState(false);
	// Key for "New message" chosen by the user (Settings).
	const composeHint = useShortcutHint("compose");
	const [appeared, setAppeared] = useState(false);
	const [sentMailboxId, setSentMailboxId] = useState<string>();
	const editorRef = useRef<EmailEditorHandle>(null);
	const params = useParams();
	const router = useRouter();
	const isMobile = useMediaQuery("(max-width: 768px)");
	const composing = useMailStore((s) => s.composing);
	const parked = useMailStore((s) => s.composeParked);
	const slot = useMailStore((s) => s.composeSlot);
	const open = isMobile ? mobileOpen : composing;

	useEffect(() => {
		if (!open || sentMailboxId || !params.identityPublicId) return;
		fetchMailbox(String(params.identityPublicId), "sent")
			.then(({ activeMailbox }) => setSentMailboxId(String(activeMailbox.id)))
			.catch(() => {});
	}, [open, sentMailboxId, params.identityPublicId]);

	useEffect(() => {
		if (!mobileOpen) return;
		const t = setTimeout(() => setAppeared(true), 16);
		return () => clearTimeout(t);
	}, [mobileOpen]);

	const handleOpen = () => {
		if (isMobile) {
			setMobileOpen(true);
			return;
		}
		openCompose();
		// Outside a folder (settings...), go back to the inbox, which provides the
		// reading pane.
		if (!params.mailboxSlug && params.identityPublicId) {
			router.push(`/w/${params.wPublicId}/dashboard/mail/${params.identityPublicId}/inbox`);
		}
	};

	const handleClose = () => {
		setMobileOpen(false);
		setAppeared(false);
		setComposeParked(false);
		closeCompose();
	};

	const editor = (
		<EmailEditor
			sentMailboxId={String(sentMailboxId)}
			ref={editorRef}
			publicConfig={publicConfig}
			identityMailboxes={identityMailboxes}
			message={null}
			onReady={() => requestAnimationFrame(() => editorRef.current?.focus())}
			showEditorMode="compose"
			handleClose={handleClose}
			onParkedChange={setComposeParked}
		/>
	);

	return (
		<>
			{isMobile ? (
				<button
					type="button"
					onClick={handleOpen}
					data-k-action="compose"
					aria-label="New message"
					className="fixed bottom-5 right-5 z-[200] flex h-14 w-14 items-center justify-center rounded-2xl bg-k-accent text-k-accent-ink shadow-k-pop"
				>
					<PencilLine size={20} />
				</button>
			) : (
				<button
					type="button"
					onClick={handleOpen}
					disabled={!params.identityPublicId}
					data-k-action="compose"
					className="k-focus group flex h-10 w-full items-center gap-2.5 rounded-k bg-k-accent px-3.5 text-[14px] font-medium text-k-accent-ink shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-k-accent-hover disabled:opacity-50"
				>
					<PencilLine className="h-4 w-4" />
					<span className="flex-1 text-left">New message</span>
					{composeHint && (
						<kbd className="rounded bg-white/15 px-1.5 font-mono text-[11px] leading-5 opacity-80">{composeHint}</kbd>
					)}
				</button>
			)}

			{/* Desktop: in the reading pane */}
			{!isMobile &&
				composing &&
				slot &&
				createPortal(
					<div className="k-fade-in flex min-h-0 flex-1 flex-col">
						<div className="flex h-12 shrink-0 items-center gap-2 border-b border-k-line pl-5 pr-2">
							<PencilLine size={15} className="text-k-ink-3" />
							<span className="text-[14px] font-semibold text-k-ink">New message</span>
							<span className="ml-auto" />
							<IconBtn label="Close" onClick={handleClose}>
								<X className="h-4 w-4" />
							</IconBtn>
						</div>
						<div className="k-scroll k-compose-body flex min-h-0 flex-1 flex-col overflow-y-auto">{editor}</div>
					</div>,
					slot,
				)}

			{/* Mobile: full screen */}
			{isMobile && mobileOpen && (
				<Portal>
					<div
							role="dialog"
						aria-modal="true"
						className={[
							parked ? "hidden" : "fixed inset-0 z-[1000] flex flex-col bg-k-surface text-k-ink",
							"motion-safe:transition-transform motion-safe:duration-200",
							appeared ? "translate-y-0" : "translate-y-3",
						].join(" ")}
					>
						<div className={parked ? "hidden" : "sticky top-0 z-10 flex items-center justify-between border-b border-k-line px-4 py-3"}>
							<div className="text-sm font-semibold">New message</div>
							<IconBtn label="Close" onClick={handleClose}>
								<X className="h-5 w-5" />
							</IconBtn>
						</div>
						<div className="k-compose-body flex min-h-0 flex-1 flex-col overflow-auto pb-[env(safe-area-inset-bottom)]">{editor}</div>
					</div>
				</Portal>
			)}
		</>
	);
}

function IconBtn({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className="rounded-k-sm p-1.5 text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
		>
			{children}
		</button>
	);
}
