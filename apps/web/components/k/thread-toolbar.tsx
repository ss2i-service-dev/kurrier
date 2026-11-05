"use client";
// Action bar of the open thread. Everything is optimistic: the action runs in
// the background and we move on to the next thread (or the list) right away.
import React, { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Archive, ArrowLeft, ChevronDown, ChevronUp, ClipboardList, Mail, Trash2, X } from "lucide-react";
import { copyMailToClipboard } from "@/lib/mail-copy";
import KIconButton from "@/components/k/icon-button";
import SnoozeMail from "@/components/k/snooze";
import { IconPin, IconPinnedOff } from "@tabler/icons-react";
import { useShortcutHint } from "@/components/k/shortcuts-config";
import { isManuallyUnread, isMarkedRead, mailActions, setActiveThread, setClosingThread, useMailStore } from "@/components/k/mail-store";

/** Visible list rows, in display order. */
function rows(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>("li[data-thread-id]")).filter((el) => el.offsetParent !== null);
}

export default function ThreadToolbar({
	threadId,
	activeMailboxId,
	activeMailboxKind,
	markSmtp,
	hasUnread,
	pinned: serverPinned = false,
}: {
	threadId: string;
	activeMailboxId: string;
	activeMailboxKind: string;
	markSmtp: boolean;
	hasUnread: boolean;
	pinned?: boolean;
}) {
	const pinOverride = useMailStore((s) => s.pinned.get(String(threadId)));
	const pinned = pinOverride ?? serverPinned;
	const router = useRouter();
	const pathname = usePathname() ?? "";
	const listUrl = pathname.replace(/\/threads\/[^/]+\/?$/, "");
	// Close the thread: a real navigation to the list (Next's router must know
	// the thread is closed, otherwise the next refresh, after read / unread...,
	// no longer matches and reloads the whole page). The reading pane hides
	// immediately, without waiting for the response.
	const close = () => {
		setClosingThread(threadId);
		setActiveThread(null);
		router.push(listUrl, { scroll: false });
	};

	// Opening a thread marks it read: immediately on screen, in the background on the server.
	const marked = useRef<string | null>(null);
	useEffect(() => {
		if (!hasUnread || marked.current === threadId) return;
		marked.current = threadId;
		// manually set back to unread: leave it unread (the pane may be redrawn
		// after the refresh that follows the action)
		if (isManuallyUnread(threadId)) return;
		// already done on click in the list (opened from the list)
		if (isMarkedRead(threadId)) return;
		mailActions.read(threadId, activeMailboxId, markSmtp, 1);
	}, [threadId, hasUnread, activeMailboxId, markSmtp]);

	const neighbour = (step: 1 | -1) => {
		const list = rows();
		const i = list.findIndex((el) => el.dataset.threadId === threadId);
		if (i < 0) return null;
		return list[i + step] ?? null;
	};
	const go = (step: 1 | -1) => {
		const el = neighbour(step);
		if (el) {
			el.click();
			el.scrollIntoView({ block: "nearest" });
		}
	};
	// After archive/delete: next thread, otherwise previous, otherwise the list.
	const advance = () => {
		const el = neighbour(1) ?? neighbour(-1);
		if (el) el.click();
		else close();
	};

	const archive = () => {
		advance();
		mailActions.archive(threadId, activeMailboxId, markSmtp);
	};
	const trash = () => {
		advance();
		mailActions.trash(threadId, activeMailboxId, markSmtp, activeMailboxKind === "trash");
	};
	const unread = () => {
		mailActions.unread(threadId, activeMailboxId, markSmtp, 1);
		close();
	};

	// Keys shown in the tooltips: the user's own (Settings).
	const hint = {
		close: useShortcutHint("close"),
		archive: useShortcutHint("archive"),
		delete: useShortcutHint("delete"),
		unread: useShortcutHint("unread"),
		prev: useShortcutHint("prev"),
		next: useShortcutHint("next"),
	};

	return (
		<div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-k-line px-2">
			<KIconButton label="Close" shortcut={hint.close} action="close" onClick={close}>
				<ArrowLeft className="lg:hidden" />
				<X className="hidden lg:block" />
			</KIconButton>
			<span className="mx-1.5 h-5 w-px bg-k-line" />
			{activeMailboxKind !== "archive" && (
				<KIconButton label="Archive" shortcut={hint.archive} action="archive" onClick={archive}>
					<Archive />
				</KIconButton>
			)}
			<KIconButton
				label={activeMailboxKind === "trash" ? "Delete permanently" : "Delete"}
				shortcut={hint.delete}
				tone="danger"
				action="delete"
				onClick={trash}
			>
				<Trash2 />
			</KIconButton>
			<KIconButton label="Mark as unread" shortcut={hint.unread} action="unread" onClick={unread}>
				<Mail />
			</KIconButton>
			<SnoozeMail mailboxThreadId={threadId} activeMailboxId={activeMailboxId} />
			<KIconButton
				label={pinned ? "Unpin" : "Pin to top of folder"}
				onClick={() => mailActions.pin(threadId, !pinned)}
				className={pinned ? "text-k-accent" : undefined}
			>
				{pinned ? <IconPinnedOff /> : <IconPin />}
			</KIconButton>
			<KIconButton label="Copy the whole thread (for an AI agent)" onClick={() => copyMailToClipboard({ threadId: String(threadId) })}>
				<ClipboardList />
			</KIconButton>

			<div className="ml-auto flex items-center">
				<KIconButton label="Previous thread" shortcut={hint.prev} onClick={() => go(-1)}>
					<ChevronUp />
				</KIconButton>
				<KIconButton label="Next thread" shortcut={hint.next} onClick={() => go(1)}>
					<ChevronDown />
				</KIconButton>
			</div>
		</div>
	);
}
