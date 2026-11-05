"use client";
// Thread list row. Two lines of text (participants + date, subject + snippet),
// an avatar that turns into a checkbox on hover, quick actions on hover (mounted
// only for the hovered row).
//
// Reproduces the classic interface's behaviours (webmail-list-item.tsx):
// selection mode (a click ticks when a box is already ticked, Shift = range),
// drafts "To: ..." and pending-send badge, trash without read/unread,
// "subject only" option, archive and delete with Undo (pending-moves).
import React from "react";
import { Archive, Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { MailboxEntity, MailboxSyncEntity } from "@db";
import { FetchMailboxThreadsResult } from "@/lib/actions/mailbox";
import { FetchLabelsResult, FetchMailboxThreadLabelsResult } from "@/lib/actions/labels";
import { IconPin, IconPinnedFilled, IconPinnedOff, IconStar, IconStarFilled } from "@tabler/icons-react";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { preventShiftTextSelection, toggleThreadSelection } from "@/lib/thread-selection";
import LabelRowTag from "@/components/dashboard/labels/label-row-tag";
import ThreadLabelHoverButtons from "@/components/dashboard/labels/thread-label-hover-buttons";
import SnoozeMail from "@/components/k/snooze";
import { useShowSnippet } from "@/components/mailbox/default/list-preview-context";
import { DraftSendBadge, DraftTimesLabel, isSendingDraft } from "@/components/mailbox/default/draft-send-status";
import KAvatar from "@/components/k/avatar";
import KIconButton from "@/components/k/icon-button";
import { correspondents, listDate } from "@/components/k/format";
import { kHref } from "@/components/k/href";
import { arrivedSinceRead, closeCompose, mailActions, setActiveThread, useMailStore } from "@/components/k/mail-store";

type Props = {
	item: FetchMailboxThreadsResult[number];
	activeMailbox: MailboxEntity;
	identityPublicId: string;
	mailboxSync: MailboxSyncEntity | undefined;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	workspacePublicId?: string;
	orderedThreadIds: string[];
	ownAddresses: Set<string>;
	isOnSnoozedPage?: boolean;
	/** Pinned thread (folder list); absent: no pinning here (search...). */
	pinned?: boolean;
};

export default function KThreadRow({
	item,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	globalLabels,
	labelsByThreadId,
	workspacePublicId,
	orderedThreadIds,
	ownAddresses,
	isOnSnoozedPage = false,
	pinned,
}: Props) {
	const router = useRouter();
	// Pinned: sender and subject only, for a compact block at the top of the list.
	const showSnippet = useShowSnippet() && !pinned;
	const isActive = useMailStore((s) => s.active === item.threadId);
	const readOverride = useMailStore((s) => s.read.get(String(item.threadId)));
	const starOverride = useMailStore((s) => s.starred.get(String(item.threadId)));
	const isTrash = activeMailbox.kind === "trash";
	const isDrafts = activeMailbox.kind === "drafts";
	const sending = isDrafts && isSendingDraft(item.draftSend);
	// A message has arrived since the thread was read or opened on screen: unread
		// marker, even if displaying it already marked it read.
	const incoming = activeMailbox.kind !== "sent" && !isDrafts;
	const arrived = incoming && arrivedSinceRead(item.threadId, item.lastActivityAt, isActive || readOverride === true);
	const isUnread = !isTrash && (arrived || (readOverride === undefined ? item.unreadCount > 0 : !readOverride));
	const starred = starOverride ?? item.starred;
	const smtp = !!mailboxSync;
	// Hover actions mounted only for the hovered or focused row.
	const [armed, setArmed] = React.useState(false);

	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		lastSelectedThreadId?: string;
	}>();
	const isSelected = !!state?.selectedThreadIds?.has(item.threadId);
	const selecting = (state?.selectedThreadIds?.size ?? 0) > 0;

	// Participants: recipients in Sent and Drafts, senders elsewhere.
	const outgoing = activeMailbox.kind === "sent" || isDrafts;
	const p = item.participants ?? {};
	const people = outgoing
		? [...(p.to ?? []), ...(p.cc ?? []), ...(p.bcc ?? [])]
		: [...(p.from ?? []), ...(p.to ?? [])].filter(
				(_x, i) =>
					i < (p.from?.length ?? 0) || (p.from ?? []).every((f) => ownAddresses.has(String(f.e).toLowerCase())),
			);
	const { label: whoRaw, primary } = correspondents(people, ownAddresses);
	const who = isDrafts ? `To: ${people.length ? whoRaw : "(no recipients)"}` : whoRaw;
	// A draft's snippet may arrive as raw HTML ("<p></p>"): plain text only.
	const preview = String(item.previewText ?? "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const snoozed = item.snoozedUntil && new Date(item.snoozedUntil).getTime() > Date.now();

	const threadUrl = kHref(`/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${activeMailbox.slug}/threads/${item.threadId}`);

	const toggleSelection = (shiftKey: boolean) => {
		const id = item.threadId;
		setState((prev) => toggleThreadSelection(prev, id, shiftKey, orderedThreadIds));
	};


	const openThread = (e: React.MouseEvent) => {
		// Selection mode (as in the classic interface): a click ticks instead of opening.
		if (selecting) {
			toggleSelection(e.shiftKey);
			return;
		}
		if (isOnSnoozedPage) {
			window.location.href = threadUrl;
			return;
		}
		// Immediate feedback: highlight right away, the content follows.
		setActiveThread(item.threadId);
		closeCompose();
		// Marked read right away (row and counters), without waiting for the thread to load.
		if (isUnread && !isTrash) mailActions.read(item.threadId, activeMailbox.id, smtp, 1);
		router.push(threadUrl);
	};

	const prefetched = React.useRef(false);
	const arm = () => {
		setArmed(true);
		if (prefetched.current || isOnSnoozedPage) return;
		prefetched.current = true;
		router.prefetch(threadUrl);
	};

	const stop = (e: React.SyntheticEvent) => e.stopPropagation();
	const starButton = (
			<button
				type="button"
				aria-label={starred ? "Remove star" : "Add star"}
				onClick={(e) => {
					stop(e);
					mailActions.star(item.threadId, activeMailbox.id, starred, smtp);
				}}
				className={`ml-auto shrink-0 rounded p-0.5 transition-opacity ${
					starred ? "text-k-star" : "text-k-ink-3 opacity-0 hover:text-k-ink group-hover:opacity-100"
				}`}
			>
				{starred ? <IconStarFilled size={14} /> : <IconStar size={14} />}
			</button>
	);

	return (
		<li
			onMouseDown={preventShiftTextSelection}
			role="listitem"
			data-thread-id={item.threadId}
			aria-current={isActive ? "true" : undefined}
			data-selected={isSelected ? "true" : undefined}
			onClick={openThread}
			onMouseEnter={arm}
			onFocus={arm}
			className={[
				"k-row group relative flex cursor-pointer gap-3 rounded-k pl-6 pr-3 py-2.5 transition-colors",
				isActive ? "bg-k-selected" : isSelected ? "bg-k-accent-soft" : "hover:bg-k-hover",
				sending ? "shadow-[inset_3px_0_0_0_var(--k-accent)]" : "",
			].join(" ")}
		>
			<span
				aria-hidden
				className={`absolute bottom-2 left-0 top-2 w-[3px] rounded-full bg-k-accent transition-opacity ${isUnread ? "opacity-100" : "opacity-0"}`}
			/>

			{/* Avatar / checkbox: the whole area is clickable */}
			<div
				className="relative mt-0.5 h-8 w-8 shrink-0"
				onClick={(e) => {
					stop(e);
					if (!isOnSnoozedPage) toggleSelection(e.shiftKey);
				}}
			>
				{!isOnSnoozedPage && (
					<span
						className={`absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded-full bg-k-surface ring-1 ring-k-line-strong transition-opacity ${
							isSelected || selecting ? "opacity-100" : "opacity-0 group-hover:opacity-100"
						}`}
					>
						<input
							type="checkbox"
							checked={isSelected}
							onChange={() => toggleSelection(false)}
							aria-label={`Select "${item.subject ?? ""}"`}
							className="pointer-events-none h-4 w-4 accent-[var(--k-accent)]"
						/>
					</span>
				)}
				<KAvatar name={primary?.n} email={primary?.e ?? whoRaw} size={32} />
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className={`truncate text-[13.5px] ${isUnread ? "font-semibold text-k-ink" : "font-medium text-k-ink-2"}`}>
						{who}
					</span>
					{item.messageCount > 1 && (
						<span className="shrink-0 rounded-full bg-k-hover px-1.5 text-[11px] font-medium leading-[18px] text-k-ink-3">
							{item.messageCount}
						</span>
					)}
					<span className="ml-auto flex shrink-0 items-center gap-1.5">
						<span className="k-row-meta flex items-center gap-1.5 transition-opacity">
							{pinned && <IconPinnedFilled size={13} className="text-k-accent" aria-label="Pinned" />}
							{item.hasAttachments && <Paperclip className="h-3.5 w-3.5 text-k-ink-3" />}
							<time
								className={`text-[12px] tabular-nums ${snoozed ? "text-k-warn" : isUnread ? "font-semibold text-k-accent" : "text-k-ink-3"}`}
								title={
									snoozed
										? `Snoozed until ${new Date(item.snoozedUntil!).toLocaleString()}`
										: new Date(item.lastActivityAt).toLocaleString()
								}
							>
								{snoozed ? "Snoozed" : listDate(item.lastActivityAt)}
							</time>
						</span>
					</span>
				</div>

				<div className="mt-0.5 flex items-center gap-1.5">
					{isDrafts && <DraftSendBadge state={item.draftSend} />}
					<span className={`truncate text-[13px] ${isUnread ? "font-medium text-k-ink" : "text-k-ink-2"}`}>
						{item.subject || "(no subject)"}
					</span>
					{isDrafts && <DraftTimesLabel times={item.draftTimes} className="ml-auto text-[11.5px] text-k-ink-3" />}
					{!showSnippet && starButton}
				</div>

				{showSnippet && (
					<div className="mt-0.5 flex items-center gap-1.5">
						<LabelRowTag threadId={item.threadId} labelsByThreadId={labelsByThreadId} isRead={!isUnread} />
						<span className="truncate text-[12.5px] text-k-ink-3">{preview || (isDrafts ? "(empty draft)" : "")}</span>
						{starButton}
					</div>
				)}
			</div>

			{armed && (
				<div
					onClick={stop}
					data-k-small
					className={`k-row-actions absolute right-2 top-1.5 flex items-center gap-0.5 rounded-k-sm p-0.5 shadow-k-pop ${isActive ? "bg-k-selected" : "bg-k-surface"}`}
				>
					<ThreadLabelHoverButtons mailboxThreadItem={item} labelsByThreadId={labelsByThreadId} allLabels={globalLabels} />
					{!isTrash &&
						(isUnread ? (
							<KIconButton size="sm" label="Mark as read" onClick={() => mailActions.read(item.threadId, activeMailbox.id, smtp, 1)}>
								<MailOpen />
							</KIconButton>
						) : (
							<KIconButton size="sm" label="Mark as unread" onClick={() => mailActions.unread(item.threadId, activeMailbox.id, smtp, 1)}>
								<Mail />
							</KIconButton>
						))}
					{pinned !== undefined && (
						<KIconButton size="sm" label={pinned ? "Unpin" : "Pin to top"} onClick={() => mailActions.pin(item.threadId, !pinned)}>
							{pinned ? <IconPinnedOff /> : <IconPin />}
						</KIconButton>
					)}
					<SnoozeMail mailboxThreadId={item.threadId} activeMailboxId={activeMailbox.id} />
					{activeMailbox.kind !== "archive" && (
						<KIconButton size="sm" label="Archive" onClick={() => mailActions.archive(item.threadId, activeMailbox.id, smtp, isUnread ? 1 : 0)}>
							<Archive />
						</KIconButton>
					)}
					<KIconButton
						size="sm"
						tone="danger"
						label={isTrash ? "Delete permanently" : "Delete"}
						onClick={() => mailActions.trash(item.threadId, activeMailbox.id, smtp, isTrash, isUnread ? 1 : 0)}
					>
						<Trash2 />
					</KIconButton>
				</div>
			)}
		</li>
	);

}
