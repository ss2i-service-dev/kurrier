"use client";
import { useStripSubjectPrefixes } from "@/components/mailbox/default/compose-style-context";
import { subjectForDisplay } from "@common/subject";
import React from "react";
import { Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import {
	FetchMailboxThreadsResult,
	markAsRead,
	markAsUnread,
	moveToTrash,
	toggleStar,
} from "@/lib/actions/mailbox";
import { FetchMailboxThreadLabelsResult } from "@/lib/actions/labels";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { Temporal } from "@js-temporal/polyfill";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { moveWithUndo } from "@/lib/pending-moves";
import { useShowSnippet } from "@/components/mailbox/default/list-preview-context";
import LabelRowTag from "@/components/dashboard/labels/label-row-tag";

type Props = {
	mailboxThreadItem: FetchMailboxThreadsResult[number];
	activeMailbox: MailboxEntity;
	identityPublicId: string;
	mailboxSync: MailboxSyncEntity | undefined;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
};

import { DraftSendBadge, DraftTimesLabel, isSendingDraft } from "@/components/mailbox/default/draft-send-status";
export default function WebmailListItemMobile({
	mailboxThreadItem,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	labelsByThreadId,
}: Props) {
	const stripPrefixes = useStripSubjectPrefixes();
	const showSnippet = useShowSnippet();
	const router = useRouter();

	const dateLabel = (() => {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		try {
			const zdt = Temporal.Instant.from(
				new Date(mailboxThreadItem.lastActivityAt || Date.now()).toISOString(),
			).toZonedDateTimeISO(tz);
			const today = Temporal.Now.zonedDateTimeISO(tz).toPlainDate();
			const d = zdt.toPlainDate();
			const diff = today.since(d, { largestUnit: "day" }).days;
			if (diff === 0)
				return zdt.toLocaleString(undefined, {
					hour: "numeric",
					minute: "2-digit",
				});
			if (d.year === today.year)
				return zdt.toLocaleString(undefined, {
					month: "short",
					day: "numeric",
				});
			return zdt.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				year: "numeric",
			});
		} catch {
			return "";
		}
	})();

	const pathname = usePathname();

	// Once at least one thread is selected, tapping a row toggles its selection.
	const toggleSelected = () => {
		const next = new Set(state?.selectedThreadIds ?? new Set<string>());
		if (next.has(mailboxThreadItem.threadId)) next.delete(mailboxThreadItem.threadId);
		else next.add(mailboxThreadItem.threadId);
		setState({ ...state, selectedThreadIds: next });
	};
	const openThread = () => {
		if ((state?.selectedThreadIds?.size ?? 0) > 0) {
			toggleSelected();
			return;
		}
		const url = pathname.match("/dashboard/mail")
			? // Same link as the desktop list, with the /w/<id>/ segment (404 otherwise).
			  `/w/${pathname.match(/\/w\/([^/]+)/)?.[1]}/dashboard/mail/${identityPublicId}/${activeMailbox.slug}/threads/${mailboxThreadItem.threadId}`
			: `/mail/${identityPublicId}/${activeMailbox.slug}/threads/${mailboxThreadItem.threadId}`;
		router.push(url);
	};

	const ACTIONS_W = 96;

	function names(p: typeof mailboxThreadItem.participants) {
		const lists = [p?.from ?? [], p?.to ?? [], p?.cc ?? [], p?.bcc ?? []];
		const seen = new Set<string>();
		const out: { n?: string | null; e: string }[] = [];
		for (const list of lists) {
			for (const x of list) {
				const e = x?.e?.trim();
				if (!e) continue;
				const k = e.toLowerCase();
				if (seen.has(k)) continue;
				seen.add(k);
				out.push({ n: x.n, e });
				if (out.length >= 6) break;
			}
			if (out.length >= 6) break;
		}
		const toText = (x: { n?: string | null; e: string }) =>
			(x.n && x.n.trim()) || x.e;
		const arr = out.map(toText);
		return arr.slice(0, 3).join(", ") + (arr.length > 3 ? "…" : "");
	}

	// In the Drafts folder, show the recipients ("To: ...") rather than the sender.
	const displayNames =
		activeMailbox.kind === "drafts"
			? `To: ${names({ to: mailboxThreadItem.participants?.to, cc: mailboxThreadItem.participants?.cc, bcc: mailboxThreadItem.participants?.bcc }) || "(no recipient)"}`
			: names(mailboxThreadItem.participants);
	const canMarkAsRead = mailboxThreadItem.unreadCount > 0;
	const canMarkAsUnread =
		mailboxThreadItem.messageCount > 0 && mailboxThreadItem.unreadCount === 0;
	// In Trash, no read / unread distinction.
	const isRead =
		activeMailbox.kind === "trash" || mailboxThreadItem.unreadCount === 0;

	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
	}>();

	return (
		<li
			className={[
				"relative group grid cursor-pointer",
				"grid-cols-[auto_1fr_auto] md:grid-cols-[auto_auto_minmax(16rem,1fr)_minmax(10rem,2fr)_auto]",
				"items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/50",
				isRead ? "bg-muted/50" : "font-semibold",
				activeMailbox.kind === "drafts" && isSendingDraft(mailboxThreadItem.draftSend)
					? "!bg-sky-50 dark:!bg-sky-950/40 shadow-[inset_3px_0_0_0_rgb(2,132,199)]"
					: "",
				`md:pr-[${ACTIONS_W}px]`,
			].join(" ")}
			onClick={openThread}
		>
			{/* controls (checkbox + star) */}
			<div className="flex items-start gap-2 pt-1">
				{/* Enlarged touch target around the checkbox */}
				<span
					className="-m-2 p-2 cursor-pointer"
					onClick={(e) => {
						e.stopPropagation();
						toggleSelected();
					}}
				>
					<input
						type="checkbox"
						checked={!!state?.selectedThreadIds?.has(mailboxThreadItem.threadId)}
						onChange={toggleSelected}
						aria-label={`Select ${mailboxThreadItem.subject}`}
						className="h-4 w-4 rounded border-muted-foreground/40 pointer-events-none"
					/>
				</span>
				<button
					aria-label="Star"
					onClick={(e) => {
						e.stopPropagation();
						toggleStar(
							mailboxThreadItem.threadId,
							activeMailbox.id,
							mailboxThreadItem.starred,
							!!mailboxSync,
						);
					}}
					className="text-muted-foreground hover:text-foreground mt-[1px]"
				>
					{mailboxThreadItem.starred ? (
						<IconStarFilled className="text-yellow-400" size={14} />
					) : (
						<IconStar className="h-3.5 w-3.5" />
					)}
				</button>
			</div>

			{/* content (2-line layout) */}
			<div className="min-w-0 flex flex-col">
				<div className="flex items-center gap-2 truncate">
					<span className="truncate">{displayNames}</span>
					{mailboxThreadItem.messageCount > 1 && (
						<span className="text-xs text-muted-foreground font-normal">
							{mailboxThreadItem.messageCount}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1 truncate text-muted-foreground font-normal text-sm">
					<LabelRowTag
						threadId={mailboxThreadItem.threadId}
						labelsByThreadId={labelsByThreadId}
						isRead={isRead}
					/>
					{activeMailbox.kind === "drafts" && (
						<DraftSendBadge state={mailboxThreadItem.draftSend} />
					)}
					<span className="truncate">{subjectForDisplay(mailboxThreadItem.subject, stripPrefixes)}</span>
					{showSnippet && (
						<>
							<span className="hidden sm:inline mx-1 text-muted-foreground">–</span>
							<span className="truncate">{mailboxThreadItem.previewText}</span>
						</>
					)}
					{mailboxThreadItem.hasAttachments && (
						<Paperclip className="ml-1 h-4 w-4 text-muted-foreground hidden sm:inline" />
					)}
					{activeMailbox.kind === "drafts" && (
						<DraftTimesLabel
							times={mailboxThreadItem.draftTimes}
							className="ml-auto pl-2 text-xs font-normal text-muted-foreground"
						/>
					)}
				</div>
			</div>

			{/* meta */}
			<div className="ml-auto flex flex-col items-end justify-start gap-1 text-right">
				<time className="whitespace-nowrap text-sm text-foreground">
					{dateLabel}
				</time>
			</div>

			{/* hover actions */}
			<div
				className={[
					"pointer-events-none absolute inset-y-0 right-3 hidden md:flex items-center justify-end gap-1 bg-muted",
					`w-[${ACTIONS_W}px]`,
					"opacity-0 transition-opacity duration-150",
					"group-hover:opacity-100 group-hover:pointer-events-auto px-3 rounded-l-4xl",
				].join(" ")}
				onClick={(e) => e.stopPropagation()}
			>
				{canMarkAsUnread && (
					<button
						onClick={async () =>
							markAsUnread(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								!!mailboxSync,
								true,
							)
						}
						className="rounded p-1 hover:bg-muted"
						title="Mark as unread"
					>
						<Mail className="h-4 w-4" />
					</button>
				)}
				{canMarkAsRead && (
					<button
						onClick={async () =>
							markAsRead(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								!!mailboxSync,
							)
						}
						className="rounded p-1 hover:bg-muted"
						title="Mark as read"
					>
						<MailOpen className="h-4 w-4" />
					</button>
				)}
				<button
					onClick={() => {
						// The row leaves the list on click, the server follows (see lib/pending-moves).
						const id = String(mailboxThreadItem.threadId);
						moveWithUndo({
							mailboxId: activeMailbox.id,
							threadIds: [id],
							message: activeMailbox.kind === "trash" ? "Deleted forever" : "Moved to Trash",
							run: () => moveToTrash(id, activeMailbox.id, !!mailboxSync, true),
							failure: "Delete failed",
						});
					}}
					className="rounded p-1 hover:bg-muted"
					title="Delete"
				>
					<Trash2 className="h-4 w-4" />
				</button>
			</div>
		</li>
	);
}
