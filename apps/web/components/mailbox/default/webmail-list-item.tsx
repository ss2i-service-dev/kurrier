"use client";
import React from "react";
import { Archive, Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { MailboxEntity, MailboxSyncEntity } from "@db";
import {
	FetchMailboxThreadsResult,
	markAsRead,
	markAsUnread,
	archiveThread,
	moveToTrash,
	toggleStar,
} from "@/lib/actions/mailbox";
import {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import { IconStar, IconStarFilled } from "@tabler/icons-react";

type Props = {
	mailboxThreadItem: FetchMailboxThreadsResult[number];
	activeMailbox: MailboxEntity;
	identityPublicId: string;
	mailboxSync: MailboxSyncEntity | undefined;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	workspacePublicId?: string;
	// Displayed order of the threads, for range selection (Shift+click).
	// Required: a list that omits it breaks Shift+click.
	orderedThreadIds: string[];
};
import { Temporal } from "@js-temporal/polyfill";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { preventShiftTextSelection, toggleThreadSelection } from "@/lib/thread-selection";
import { moveWithUndo } from "@/lib/pending-moves";
import LabelRowTag from "@/components/dashboard/labels/label-row-tag";
import ThreadLabelHoverButtons from "@/components/dashboard/labels/thread-label-hover-buttons";
import SnoozeMail from "@/components/mailbox/default/snooze-mail";
import { useShowSnippet } from "@/components/mailbox/default/list-preview-context";
import { DraftSendBadge, DraftTimesLabel, isSendingDraft } from "@/components/mailbox/default/draft-send-status";

export default function WebmailListItem({
	mailboxThreadItem,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	globalLabels,
	labelsByThreadId,
	workspacePublicId,
	orderedThreadIds,
}: Props) {
	const showSnippet = useShowSnippet();
	function formatDateLabel(input?: string | number | Date) {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!input) return "";

		let zdt: Temporal.ZonedDateTime;
		try {
			const instant = Temporal.Instant.from(new Date(input).toISOString());
			zdt = instant.toZonedDateTimeISO(tz);
		} catch {
			return "";
		}

		const today = Temporal.Now.zonedDateTimeISO(tz).toPlainDate();
		const date = zdt.toPlainDate();

		const diffDays = today.since(date, { largestUnit: "day" }).days;

		if (diffDays === 0) {
			return zdt.toLocaleString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			});
		}

		if (date.year === today.year) {
			return zdt.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
			});
		}

		return zdt.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	}

	function formatRelative(input?: string | number | Date) {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!input) return "";

		let zdt: Temporal.ZonedDateTime;
		try {
			const instant = Temporal.Instant.from(new Date(input).toISOString());
			zdt = instant.toZonedDateTimeISO(tz);
		} catch {
			return "";
		}

		const now = Temporal.Now.zonedDateTimeISO(tz);
		const dur = now.since(zdt, { largestUnit: "day" });

		const days = Math.abs(dur.days);
		const hours = Math.abs(dur.hours);
		const minutes = Math.abs(dur.minutes);

		if (days >= 1) return `${days}d ago`;
		if (hours >= 1) return `${hours}h ago`;
		if (minutes >= 1) return `${minutes}m ago`;
		return "just now";
	}

	function getThreadTimeLabel(item: typeof mailboxThreadItem) {
		const now = Date.now();

		if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now) {
			return {
				text: "Snoozed",
				className: "text-sm text-orange-400",
				title: `Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}`,
			};
		}

		if (item.unsnoozedAt) {
			const ageMs = now - new Date(item.unsnoozedAt).getTime();
			const showWindowMs = 60 * 60 * 1000;

			if (ageMs >= 0 && ageMs <= showWindowMs) {
				return {
					text: `Snoozed back ${formatRelative(item.unsnoozedAt)}`,
					className: "text-sm text-orange-400",
					title: `Returned from snooze ${new Date(item.unsnoozedAt).toLocaleString()}`,
				};
			}
		}

		const date = new Date(item.lastActivityAt || now);
		return {
			text: formatDateLabel(date),
			className: "text-sm text-foreground",
			title: "",
		};
	}

	const router = useRouter();

	const date = new Date(mailboxThreadItem.lastActivityAt || Date.now());
	const dateLabel = formatDateLabel(date);
	const timeLabel = getThreadTimeLabel(mailboxThreadItem);

	const pathname = usePathname();
	const isOnSnoozedPage = pathname.split("/").includes("snoozed");

	// Once at least one thread is selected we are in selection mode: a click on
	// the row toggles it instead of opening the thread (Shift+click = range).
	const openThread = async (e?: React.MouseEvent) => {
		if ((state?.selectedThreadIds?.size ?? 0) > 0) {
			toggleSelection(!!e?.shiftKey);
			return;
		}
		const url = pathname.match("/dashboard/mail")
			? `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${activeMailbox.slug}/threads/${mailboxThreadItem.threadId}`
			: `/mail/${identityPublicId}/${activeMailbox.slug}/threads/${mailboxThreadItem.threadId}`;

		// TODO: Fix full page reload on snoozed page, hoist @thread layout to higher level
		if (isOnSnoozedPage) {
			window.location.href = url;
			return;
		}
		router.push(url);
	};

	const ACTIONS_W = "96px";

	function getAllNames(p: typeof mailboxThreadItem.participants) {
		const lists = [p?.from ?? [], p?.to ?? [], p?.cc ?? [], p?.bcc ?? []];

		const seen = new Set<string>();
		const merged: { n?: string | null; e: string }[] = [];

		for (const list of lists) {
			for (const x of list) {
				const e = x?.e?.trim();
				if (!e) continue;
				const key = e.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push({ n: x.n, e });
				if (merged.length >= 6) break;
			}
			if (merged.length >= 6) break;
		}

		const displayName = (x: { n?: string | null; e: string }) =>
			(x.n && x.n.trim()) || x.e;

		const names = merged.map(displayName);
		const shown = names.slice(0, 3);
		const suffix = names.length > 3 ? "…" : "";

		return shown.join(", ") + suffix;
	}

	// In the Drafts folder, show the recipients ("To: ...") rather than the sender.
	const isDrafts = activeMailbox.kind === "drafts";
	const allNames = isDrafts
		? `To: ${getAllNames({ to: mailboxThreadItem.participants?.to, cc: mailboxThreadItem.participants?.cc, bcc: mailboxThreadItem.participants?.bcc }) || "(no recipient)"}`
		: getAllNames(mailboxThreadItem.participants);

	const canMarkAsRead = mailboxThreadItem.unreadCount > 0;
	const canMarkAsUnread =
		mailboxThreadItem.messageCount > 0 && mailboxThreadItem.unreadCount === 0;

	// In Trash, no read / unread distinction (no bold, no icon).
	const isTrash = activeMailbox.kind === "trash";
	const isUnread = !isTrash && mailboxThreadItem.unreadCount > 0;
	const isRead = !isUnread;

	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		lastSelectedThreadId?: string;
	}>();

	// Shift+click applies the clicked checkbox's state to the whole range since
	// the last clicked checkbox, like Gmail (lib/thread-selection.ts, tested).
	const toggleSelection = (shiftKey: boolean) => {
		const id = mailboxThreadItem.threadId;
		setState((prev) => toggleThreadSelection(prev, id, shiftKey, orderedThreadIds));
	};

	return (
		<>
			<li
				onMouseDown={preventShiftTextSelection}
				className={[
					"relative group grid cursor-pointer",
					// "grid-cols-[auto_auto_minmax(16rem,1fr)_minmax(10rem,2fr)_auto]",
					"grid-cols-[auto_auto_20rem_minmax(10rem,2fr)_auto]",
					// "grid-cols-[auto_auto_minmax(8rem,12rem)_minmax(10rem,2fr)_auto]",
					"items-center gap-3 pl-6 pr-3 py-2 transition-colors hover:bg-muted/50",
					isRead ? "bg-muted/50" : "font-semibold",
					// Pending send: Outbox row (tint and left rule), not a draft.
					isDrafts && isSendingDraft(mailboxThreadItem.draftSend)
						? "!bg-sky-50 dark:!bg-sky-950/40 shadow-[inset_3px_0_0_0_rgb(2,132,199)]"
						: "",
					`pr-[${ACTIONS_W}]`,
				].join(" ")}
			>
				{/* The whole checkbox cell is clickable (row height, overflowing to the
				    left), not only the 16 px box. The box no longer captures the mouse;
				    from the keyboard (space), onChange still toggles it. */}
				<div
					className={
						isOnSnoozedPage
							? "flex items-center"
							: "flex items-center self-stretch -my-2 -ml-6 pl-6 pr-2 cursor-pointer"
					}
					onClick={(e) => {
						if (isOnSnoozedPage) return;
						e.stopPropagation();
						toggleSelection(e.shiftKey);
					}}
				>
					{!isOnSnoozedPage && (
						<input
							type="checkbox"
							onChange={() => toggleSelection(false)}
							checked={!!state?.selectedThreadIds?.has(
								mailboxThreadItem.threadId,
							)}
							aria-label={`Select thread ${mailboxThreadItem.subject}`}
							className="h-4 w-4 rounded border-muted-foreground/40 pointer-events-none"
						/>
					)}
				</div>

				<button
					type="button"
					aria-label="Star"
					className="text-muted-foreground hover:text-foreground"
					onClick={() =>
						toggleStar(
							mailboxThreadItem.threadId,
							activeMailbox.id,
							mailboxThreadItem.starred,
							!!mailboxSync,
						)
					}
				>
					{mailboxThreadItem.starred ? (
						<IconStarFilled className={"text-yellow-400"} size={12} />
					) : (
						<IconStar className="h-3 w-3" />
					)}
				</button>

				<div onClick={openThread} className="truncate pr-2">
					<span className="truncate">{allNames}</span>{" "}
					{mailboxThreadItem.messageCount > 1 && (
						<span className="text-xs text-muted-foreground font-normal">
							{mailboxThreadItem.messageCount}
						</span>
					)}
				</div>

				<div
					onClick={openThread}
					className="flex min-w-0 items-center gap-1 pr-2"
				>
					<LabelRowTag
						threadId={mailboxThreadItem.threadId}
						labelsByThreadId={labelsByThreadId}
						isRead={isRead}
					/>
					{isDrafts && <DraftSendBadge state={mailboxThreadItem.draftSend} />}
					<span className="truncate">{mailboxThreadItem.subject}</span>
					{showSnippet && (
						<>
							<span className="mx-1 text-muted-foreground">–</span>
							<span className="truncate text-muted-foreground font-normal">
								{mailboxThreadItem.previewText}
							</span>
						</>
					)}
					{mailboxThreadItem.hasAttachments && (
						<Paperclip className="ml-1 hidden h-4 w-4 text-muted-foreground md:inline" />
					)}
					{isDrafts && (
						<DraftTimesLabel
							times={mailboxThreadItem.draftTimes}
							className="ml-auto pl-2 text-xs font-normal text-muted-foreground"
						/>
					)}
				</div>

				<div className="ml-auto flex items-center gap-2 pl-2">
					{isUnread ? (
						<Mail className="h-4 w-4 text-primary md:hidden" />
					) : (
						<MailOpen className="h-4 w-4 text-muted-foreground md:hidden" />
					)}
					{/*<time className="whitespace-nowrap text-sm text-foreground">*/}
					{/*	{dateLabel}*/}
					{/*</time>*/}
					<time
						className={["whitespace-nowrap", timeLabel.className].join(" ")}
						title={timeLabel.title}
					>
						{timeLabel.text}
					</time>
				</div>

				<div
					className={[
						"pointer-events-none absolute inset-y-0 right-3 flex items-center justify-end gap-1 bg-muted",
						`w-[${ACTIONS_W}]`,
						"opacity-0 transition-opacity duration-100",
						"group-hover:opacity-100 group-hover:pointer-events-auto px-3 rounded-l-4xl",
					].join(" ")}
					onClick={(e) => e.stopPropagation()}
				>
					<ThreadLabelHoverButtons
						mailboxThreadItem={mailboxThreadItem}
						labelsByThreadId={labelsByThreadId}
						allLabels={globalLabels}
					/>

					{canMarkAsUnread && (
						<button
							onClick={async () => {
								return await markAsUnread(
									mailboxThreadItem.threadId,
									activeMailbox.id,
									!!mailboxSync,
									true,
								);
							}}
							className="rounded p-1 hover:bg-muted"
							title="Mark as unread"
						>
							<Mail className="h-4 w-4" />
						</button>
					)}
					{canMarkAsRead && (
						<button
							onClick={() =>
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

					<SnoozeMail
						mailboxThreadId={mailboxThreadItem.threadId}
						activeMailboxId={activeMailbox.id}
					/>

					{activeMailbox.kind !== "archive" && (
						<button
							onClick={() => {
								const id = String(mailboxThreadItem.threadId);
								moveWithUndo({
									mailboxId: activeMailbox.id,
									threadIds: [id],
									message: "Archived",
									run: () => archiveThread(id, activeMailbox.id, !!mailboxSync, true),
									failure: "Archive failed",
								});
							}}
							className="rounded p-1 hover:bg-muted"
							title="Archive"
						>
							<Archive className="h-4 w-4" />
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
		</>
	);
}
