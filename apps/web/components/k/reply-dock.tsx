"use client";
// SS2i : zone de reponse ancree en bas du panneau de lecture. Fermee, trois
// boutons ; ouverte, l'editeur, le fil restant visible et defilable au-dessus.
import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Forward, Reply, ReplyAll, X } from "lucide-react";
import type { PublicConfig } from "@schema";
import type { FetchIdentityMailboxListResult } from "@/lib/actions/mailbox";
import type { EmailEditorHandle } from "@/components/mailbox/default/editor/email-editor";
import { replyRecipients } from "@/lib/reply-recipients";
import { useThread, type ReplyMode } from "@/components/k/thread-context";
import { displayName } from "@/components/k/format";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import KIconButton from "@/components/k/icon-button";

const EmailEditor = dynamic(() => import("@/components/mailbox/default/editor/email-editor"), {
	ssr: false,
	loading: () => <div className="h-48 animate-pulse bg-k-surface-2" />,
});

const MODE_LABEL: Record<ReplyMode, string> = {
	reply: "Répondre",
	replyAll: "Répondre à tous",
	forward: "Transférer",
};

export default function ReplyDock({
	lastMessageId,
	publicConfig,
	identityMailboxes,
	sentMailboxId,
}: {
	lastMessageId: string;
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
	sentMailboxId?: string;
}) {
	const { reply, openReply, closeReply, getMessage } = useThread();
	const editorRef = useRef<EmailEditorHandle>(null);
	const [, force] = useState(0);
	// Les messages s'enregistrent au montage : un rendu de plus pour les voir.
	useEffect(() => force((n) => n + 1), []);

	const own = useMemo(() => identityMailboxes.map((im) => String(im.identity.value)), [identityMailboxes]);
	const last = getMessage(lastMessageId);
	const hasOthers = useMemo(() => (last ? replyRecipients(last, own).cc.length > 0 : false), [last, own]);
	const defaultMode: ReplyMode = hasOthers ? "replyAll" : "reply";
	const target = reply ? getMessage(reply.messageId) : undefined;
	// Reponse envoyee mais encore annulable : l'editeur reste monte, cache (comme la classique).
	const [parked, setParked] = useState(false);

	// Hauteur de la zone de reponse, reglable a la souris et memorisee.
	const dockRef = useRef<HTMLDivElement>(null);
	const MIN = 180;
	const paneHeight = () => dockRef.current?.parentElement?.clientHeight ?? window.innerHeight;
	const [height, setHeight] = useState<number>(() => {
		if (typeof window === "undefined") return 380;
		try {
			const v = Number(localStorage.getItem("k-reply-height"));
			if (v >= MIN) return v;
		} catch {}
		return Math.round(window.innerHeight * 0.45);
	});
	const clamp = (h: number) => Math.max(MIN, Math.min(h, paneHeight() - 110));
	const save = (h: number) => {
		try {
			localStorage.setItem("k-reply-height", String(Math.round(h)));
		} catch {}
	};
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const startH = dockRef.current?.offsetHeight ?? height;
		let last = startH;
		const move = (ev: PointerEvent) => {
			last = clamp(startH + (startY - ev.clientY));
			setHeight(last);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			save(last);
		};
		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const toggleMax = () => {
		const max = paneHeight() - 110;
		const next = height >= max - 4 ? Math.round(paneHeight() * 0.45) : max;
		setHeight(clamp(next));
		save(clamp(next));
	};

	const bar = renderBar();
	if (reply && target) {
		return (
			<>
			{parked && bar}
			<div
				ref={dockRef}
				hidden={parked}
				style={{ height, ["--k-reply-h" as any]: `${height}px` }}
				className="k-fade-in relative flex shrink-0 flex-col border-t border-k-line bg-k-surface shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.12)]"
			>
				{/* Poignee : glisser pour redimensionner, double-clic pour agrandir / revenir. */}
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label="Redimensionner la zone de réponse"
					title="Glisser pour redimensionner, double-clic pour agrandir"
					onPointerDown={startResize}
					onDoubleClick={toggleMax}
					className="group/handle absolute inset-x-0 -top-2 z-10 flex h-4 cursor-row-resize touch-none items-center justify-center"
				>
					<span className="h-1 w-10 rounded-full bg-k-line-strong transition-colors group-hover/handle:bg-k-accent" />
				</div>
				<div className="k-scroll k-reply-body min-h-0 flex-1 overflow-y-auto">
					<EmailEditor
						key={`${reply.messageId}:${reply.mode}`}
						sentMailboxId={String(sentMailboxId)}
						ref={editorRef}
						publicConfig={publicConfig}
						message={target}
						identityMailboxes={identityMailboxes}
						onReady={() => requestAnimationFrame(() => editorRef.current?.focus())}
						handleClose={() => {
							setParked(false);
							closeReply();
						}}
						onParkedChange={setParked}
						showEditorMode={reply.mode}
					/>
				</div>
			</div>
			</>
		);
	}
	return bar;

	function renderBar() {

	const btn =
		"k-focus flex h-9 items-center gap-2 rounded-k border border-k-line-strong bg-k-surface px-3 text-[13px] text-k-ink-2 transition-colors hover:border-k-accent hover:text-k-ink";
	return (
		<div className="flex shrink-0 items-center gap-2 border-t border-k-line bg-k-surface px-4 py-2.5">
			<button
				type="button"
				data-k-action="reply"
				onClick={() => openReply(lastMessageId, defaultMode)}
				className="k-focus flex h-9 items-center gap-2 rounded-k bg-k-accent px-3.5 text-[13px] font-medium text-k-accent-ink transition-colors hover:bg-k-accent-hover"
			>
				{hasOthers ? <ReplyAll size={15} /> : <Reply size={15} />}
				{MODE_LABEL[defaultMode]}
				<kbd className="rounded bg-white/15 px-1.5 font-mono text-[10.5px] leading-4">R</kbd>
			</button>
			{hasOthers && (
				<button type="button" onClick={() => openReply(lastMessageId, "reply")} className={btn}>
					<Reply size={15} />
					<span className="hidden sm:inline">Répondre à l'expéditeur</span>
				</button>
			)}
			<button type="button" data-k-action="forward" onClick={() => openReply(lastMessageId, "forward")} className={btn}>
				<Forward size={15} />
				<span className="hidden sm:inline">Transférer</span>
				<kbd className="hidden rounded border border-k-line-strong px-1.5 font-mono text-[10.5px] leading-4 text-k-ink-3 sm:inline">F</kbd>
			</button>
		</div>
	);
}
}
