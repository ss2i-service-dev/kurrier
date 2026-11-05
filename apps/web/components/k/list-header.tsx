"use client";
import { mailboxTitle } from "@/components/k/format";
import { adjustCount, mailActions, scheduleRefresh, useMailStore } from "@/components/k/mail-store";
import MobileNavButton from "@/components/k/mobile-nav-button";
import React, { useRef, useEffect, useState } from "react";
import { Archive, Inbox, ListChecks, MailOpen, RotateCw, Trash2 } from "lucide-react";
import { findLikelyNotSpam } from "@/lib/actions/spam-triage";
import { moveWithUndo } from "@/lib/pending-moves";
import { fetchAllThreadIds, type SelectAllScope } from "@/lib/actions/select-all";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import {
	archiveThread,
	deleteForever,
	deltaFetch,
	FetchIdentityMailboxListResult,
	FetchMailboxThreadsResult,
	markAsRead,
	moveToFolder,
	moveToTrash,
	revalidateMailbox,
} from "@/lib/actions/mailbox";
import { ActionIcon, Button, Tooltip } from "@mantine/core";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import KCompose from "@/components/k/compose";
import { PublicConfig } from "@schema";
import { useMediaQuery } from "@mantine/hooks";
import { clsx } from "clsx";
import MoveToFolder from "@/components/mailbox/default/move-to-folder";
import { usePathname } from "next/navigation";

// List header. Logic taken as is from mail-list-header.tsx (selection, "select
// all", Undo, spam, trash), with the modern interface's presentation.
function KListHeader({
	mailboxThreads,
	mailboxSync,
	publicConfig,
	identityMailboxes,
	activeMailbox,
	selectAllScope,
	totalThreads,
	mayHaveMore,
	title,
}: {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
	activeMailbox: MailboxEntity;
	mailboxSync?: MailboxSyncEntity;
	// "Select all" beyond the page. Without a scope, the option is not offered.
	selectAllScope?: SelectAllScope;
	// Total number of threads if known (search), otherwise mayHaveMore says whether there are more.
	totalThreads?: number;
	mayHaveMore?: boolean;
	// Title specific to screens outside a folder (search, label, snoozed).
	title?: React.ReactNode;
}) {
	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
		// The selection covers the whole folder or search, including pages not shown.
		allMatching?: boolean;
		// Cap reached: only the most recent are selected.
		allMatchingTruncated?: boolean;
	}>();

	// Read / unread state as displayed (including the store's instant actions).
	const readOverride = useMailStore((st) => st.read);
	const isUnreadNow = (t: { threadId: string; unreadCount: number }) => {
		const o = readOverride.get(String(t.threadId));
		return o === undefined ? t.unreadCount > 0 : !o;
	};
	const unreadAmong = (ids: string[]) => {
		const set = new Set(ids);
		return mailboxThreads.filter((t) => set.has(String(t.threadId)) && isUnreadNow(t)).length;
	};

	const identityIdRef = useRef<string | undefined>(activeMailbox?.identityId);
	const mailboxIdRef = useRef<string | undefined>(activeMailbox?.id);
	const mailboxKind = useRef<string | undefined>(activeMailbox?.kind);
	useEffect(() => {
		if (activeMailbox?.identityId)
			identityIdRef.current = activeMailbox.identityId;
		if (activeMailbox?.id) mailboxIdRef.current = activeMailbox.id;
	}, [activeMailbox?.identityId, activeMailbox?.id]);

	const selectedSize = state?.selectedThreadIds?.size ?? 0;
	const hasSelected = selectedSize > 0;
	// "All ticked" = every displayed thread is in the selection. Comparing only the
		// sizes is not enough: after the list reloads (deleted threads replaced by the
		// next page), a selection of old threads of the same size would tick the box
		// with no row ticked, and a click would only "untick all".
	const visibleIds = mailboxThreads.map((t) => t.threadId);
	const isChecked =
		visibleIds.length > 0 &&
		visibleIds.every((id) => state?.selectedThreadIds?.has(id));

	// The selection only keeps displayed threads, otherwise an action (trash,
		// archive) would apply to threads that are no longer visible.
		// Exception: after "Select all N conversations", the selection deliberately
		// covers threads from other pages; it becomes a page selection again once cleared.
	const allMatching = !!state?.allMatching && selectedSize > 0;
	const visibleKey = visibleIds.join(",");
	useEffect(() => {
		const visible = new Set(visibleKey ? visibleKey.split(",") : []);
		setState((prev) => {
			const sel = prev?.selectedThreadIds;
			if (!sel?.size) return prev?.allMatching ? { ...prev, allMatching: false } : prev;
			if (prev?.allMatching) return prev;
			const kept = new Set([...sel].filter((id) => visible.has(id)));
			return kept.size === sel.size ? prev : { ...prev, selectedThreadIds: kept };
		});
	}, [visibleKey, setState]);

	const [selectingAll, setSelectingAll] = useState(false);
	const hasMore =
		!!selectAllScope && (totalThreads != null ? totalThreads > visibleIds.length : !!mayHaveMore);
	const selectAllMatching = async () => {
		if (!selectAllScope) return;
		setSelectingAll(true);
		try {
			const { ids, truncated } = await fetchAllThreadIds(selectAllScope);
			const next = new Set<string>([...visibleIds, ...ids]);
			setState((prev) => ({
				...prev,
				selectedThreadIds: next,
				allMatching: true,
				allMatchingTruncated: truncated,
			}));
		} catch (e: any) {
			toast.error(e?.message ?? "Selection failed", { position: "bottom-center" });
		} finally {
			setSelectingAll(false);
		}
	};
	const clearSelection = () =>
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
	const scopeLabel =
		selectAllScope?.kind === "search" ? "of this search" : `of "${mailboxTitle(activeMailbox?.kind, activeMailbox?.name)}"`;

	const [reloading, setReloading] = useState(false);
	const reload = async () => {
		if (mailboxSync) {
			const identityId = identityIdRef.current;
			if (!identityId) return;
			try {
				setReloading(true);
				await deltaFetch({ identityId });
				await revalidateMailbox("/mail");
			} finally {
				setReloading(false);
			}
		} else {
			revalidateMailbox("/mail");
		}
	};

	const markRead = () => {
		const ids = Array.from(state?.selectedThreadIds ?? []).map(String);
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
		mailActions.read(ids, String(mailboxIdRef.current), !!mailboxSync, unreadAmong(ids));
	};

	// The selection leaves the list on click, with an "Undo" toast; the server is
		// only called once the undo window ends (see lib/pending-moves). On failure,
		// the threads come back with the error.
	const applyToSelection = (
		run: (ids: string[], mailboxId: string) => Promise<unknown>,
		done: (n: number) => string,
		// archiving only takes the thread out of the Inbox
		archive = false,
	) => {
		const ids = Array.from(state?.selectedThreadIds ?? []).map(String);
		const mailboxId = String(mailboxIdRef.current);
		if (!ids.length) return;
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
		// sidebar counter: unread threads leaving the folder
		const unread = unreadAmong(ids);
		adjustCount(mailboxId, -unread);
		moveWithUndo({
			mailboxId,
			threadIds: ids,
			message: done(ids.length),
			onUndo: () => adjustCount(mailboxId, unread),
			archive,
			// actions without waiting for the worker or a full render (refresh=false
						// below), then a discreet refresh.
			run: () => run(ids, mailboxId),
			onDone: () => scheduleRefresh(),
		});
	};
	const plural = (n: number) => (n > 1 ? `${n} threads` : "Thread");

	const deleteThreads = () => {
		if (mailboxKind.current === "trash") {
			removeTrash();
			return;
		}
		applyToSelection(
			(ids, mailboxId) => moveToTrash(ids, mailboxId, !!mailboxSync, false),
			(n) => `${plural(n)} moved to trash`,
		);
	};

	const archiveThreads = () =>
		applyToSelection(
			(ids, mailboxId) => archiveThread(ids, mailboxId, !!mailboxSync, false),
			(n) => `${plural(n)} archived`,
			true,
		);

	// Spam page. Preselects the threads that are probably legitimate (sender
		// already seen outside spam, or someone we have written to), then sends them
		// back to the inbox.
	const [triaging, setTriaging] = useState(false);
	const selectLikelyNotSpam = async () => {
		try {
			setTriaging(true);
			const found = new Set(await findLikelyNotSpam(String(mailboxIdRef.current)));
			const shown = mailboxThreads.map((t) => String(t.threadId)).filter((id) => found.has(id));
			setState((prev) => ({ ...prev, selectedThreadIds: new Set(shown) }));
			if (shown.length === 0) toast.info("No message looks legitimate here", { position: "bottom-center" });
			else toast.success(`${shown.length} message(s) selected, check before moving`, { position: "bottom-center" });
		} catch (e: any) {
			toast.error(e?.message ?? "Selection failed");
		} finally {
			setTriaging(false);
		}
	};
	const inboxId = identityMailboxes
		.find((im) => im.identity.id === activeMailbox?.identityId)
		?.mailboxes?.find((m: any) => m?.kind === "inbox")?.id;
	const notSpam = () => {
		if (!inboxId) return;
		applyToSelection(
			(ids, mailboxId) =>
				moveToFolder(ids, mailboxId, String(inboxId), !!mailboxSync, false),
			(n) => `${plural(n)} moved back to the inbox`,
		);
	};

	const removeTrash = () =>
		applyToSelection(
			(ids, mailboxId) => deleteForever(ids, mailboxId, !!mailboxSync, false),
			(n) => `${plural(n)} deleted permanently`,
		);

	const emptyTrash = async () => {
		await deleteForever(
			null,
			String(mailboxIdRef.current),
			!!mailboxSync,
			true,
			{
				emptyAll: true,
			},
		);
		toast.success("Trash emptied", { position: "bottom-center" });
	};

	const isMobile = useMediaQuery("(max-width: 768px)");
	const pathName = usePathname();
	const isOnSnoozedPage = pathName.split("/").includes("snoozed");
	const unreadInView = mailboxThreads.filter((t) => isUnreadNow(t)).length;
	const filter = (state as any)?.filter ?? "all";
	const setFilter = (f: "all" | "unread") => setState((prev) => ({ ...(prev ?? {}), filter: f }));
	const bulkBtn =
		"inline-flex h-8 items-center gap-1.5 rounded-k-sm px-2 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink";

	return (
		<>
			<div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-k-surface px-3">
				{!isOnSnoozedPage && (
					<label className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-k-sm hover:bg-k-hover">
						<input
							type="checkbox"
							onChange={() => {
								// The box ticks the page's threads; unticking after "whole folder" clears the whole selection.
								if (isChecked && allMatching) {
									clearSelection();
									return;
								}
								const newSet = new Set(state?.selectedThreadIds ?? []);
								if (!isChecked) mailboxThreads.forEach((t) => newSet.add(t.threadId));
								else mailboxThreads.forEach((t) => newSet.delete(t.threadId));
								setState((prev) => ({ ...(prev ?? {}), selectedThreadIds: newSet }));
							}}
							checked={isChecked}
							aria-label="Select all"
							className="h-4 w-4 cursor-pointer accent-[var(--k-accent)]"
						/>
					</label>
				)}

				{hasSelected ? (
					<div className="k-fade-in flex min-w-0 flex-1 items-center gap-0.5">
						<span className="mr-1 whitespace-nowrap text-[13px] font-medium text-k-ink">
							{selectedSize} selected
						</span>
						<MoveToFolder identityMailboxes={identityMailboxes} activeMailbox={activeMailbox} />
						{mailboxKind.current === "spam" && inboxId && (
							<button type="button" onClick={notSpam} className={bulkBtn} title="Not spam: move back to the inbox">
								<Inbox className="h-4 w-4" />
								Not spam
							</button>
						)}
						{mailboxKind.current !== "archive" && (
							<button type="button" onClick={archiveThreads} className={bulkBtn} title="Archive" data-k-shortcut="selection-archive">
								<Archive className="h-4 w-4" />
							</button>
						)}
						<button type="button" onClick={markRead} className={bulkBtn} title="Mark as read">
							<MailOpen className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={deleteThreads}
							className={`${bulkBtn} hover:!bg-k-danger-soft hover:!text-k-danger`}
							title={mailboxKind.current === "trash" ? "Delete permanently" : "Delete"}
							data-k-shortcut="selection-delete"
						>
							<Trash2 className="h-4 w-4" />
						</button>
						<button type="button" onClick={clearSelection} className={`${bulkBtn} ml-auto`}>
							Cancel
						</button>
					</div>
				) : (
					<>
						<div className="min-w-0 flex-1">
							<h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-k-ink">
								{title ?? mailboxTitle(activeMailbox.kind, activeMailbox.name)}
								{unreadInView > 0 && mailboxKind.current !== "trash" && (
									<span className="ml-2 text-[13px] font-normal text-k-ink-3">
										{unreadInView} unread
									</span>
								)}
							</h1>
						</div>

						{mailboxKind.current === "spam" && (
							<Tooltip
								label="Selects the messages that are probably legitimate: sender already seen outside spam, or someone you have written to"
								multiline
								w={260}
								withArrow
							>
								<Button size="xs" variant="subtle" loading={triaging} leftSection={<ListChecks size={15} />} onClick={selectLikelyNotSpam}>
									Triage
								</Button>
							</Tooltip>
						)}

						<div className="flex rounded-k-sm bg-k-hover p-0.5 text-[12.5px]">
							{(
								[
									["all", "All"],
									["unread", "Unread"],
								] as const
							).map(([f, label]) => (
								<button
									key={f}
									type="button"
									onClick={() => setFilter(f)}
									className={`rounded-[5px] px-2.5 py-1 transition-colors ${
										filter === f ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:text-k-ink"
									}`}
								>
									{label}
								</button>
							))}
						</div>

						<Tooltip label="Sync" withArrow openDelay={350} fz="xs">
							<button
								type="button"
								onClick={reload}
								aria-label="Sync"
								className="flex h-8 w-8 items-center justify-center rounded-k-sm text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
							>
								<RotateCw className={reloading ? "animate-spin" : ""} size={15} />
							</button>
						</Tooltip>
					</>
				)}

				{isMobile && <KCompose publicConfig={publicConfig} identityMailboxes={identityMailboxes} />}
			</div>

			{/* "Select all" banner beyond the page (as in the classic interface). */}
			{!isOnSnoozedPage && isChecked && (hasMore || allMatching) && (
				<div className="mx-3 mb-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-k bg-k-accent-soft px-3 py-1.5 text-[12.5px] text-k-ink-2">
					{allMatching ? (
						<>
							<span>
								{state?.allMatchingTruncated
									? `The ${selectedSize} most recent threads ${scopeLabel} are selected (limit reached).`
									: `All ${selectedSize} threads ${scopeLabel} are selected.`}
							</span>
							<button type="button" onClick={clearSelection} className="font-semibold text-k-accent hover:underline">
								Clear selection
								</button>
						</>
					) : (
						<>
							<span>All {visibleIds.length} threads on this page are selected.</span>
							<button
								type="button"
								onClick={selectAllMatching}
								disabled={selectingAll}
								className="font-semibold text-k-accent hover:underline disabled:opacity-60"
								data-k-shortcut="selection-select-all-matching"
							>
								{selectingAll
									? "Selecting…"
									: totalThreads != null
										? `Select all ${totalThreads} threads ${scopeLabel}`
										: `Select all threads ${scopeLabel}`}
							</button>
						</>
					)}
				</div>
			)}

			{mailboxKind.current === "trash" && (
				<div className="mx-3 mb-2 flex items-center gap-3 rounded-k bg-k-surface-2 px-3 py-2 text-[12.5px] text-k-ink-2">
					<span className="flex-1">Messages older than 30 days in the trash are deleted automatically.</span>
					<AlertDialog>
						<AlertDialogTrigger asChild={true}>
							<button type="button" className="shrink-0 font-medium text-k-danger hover:underline">
								Empty trash
								</button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Empty trash?</AlertDialogTitle>
								<AlertDialogDescription>
									All messages in the trash will be permanently deleted, including on the server. This action cannot be undone.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={emptyTrash}>Empty trash</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			)}
		</>
	);
}

export default KListHeader;
