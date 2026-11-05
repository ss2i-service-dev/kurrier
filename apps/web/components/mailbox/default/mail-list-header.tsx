"use client";
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
import ComposeMail from "@/components/mailbox/default/compose-mail";
import { PublicConfig } from "@schema";
import { useMediaQuery } from "@mantine/hooks";
import { clsx } from "clsx";
import MoveToFolder from "@/components/mailbox/default/move-to-folder";
import { usePathname } from "next/navigation";

function MailListHeader({
	mailboxThreads,
	mailboxSync,
	publicConfig,
	identityMailboxes,
	activeMailbox,
	selectAllScope,
	totalThreads,
	mayHaveMore,
}: {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
	activeMailbox: MailboxEntity;
	mailboxSync?: MailboxSyncEntity;
	// "Select all" beyond the current page. Without a scope, it is not offered.
	selectAllScope?: SelectAllScope;
	// Total number of threads when known (search), otherwise mayHaveMore tells whether there are more.
	totalThreads?: number;
	mayHaveMore?: boolean;
}) {
	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
		// The selection covers the whole folder or the whole search, hidden pages included.
		allMatching?: boolean;
		// Cap reached: only the most recent threads are selected.
		allMatchingTruncated?: boolean;
	}>();

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
	// "All checked" = every displayed thread is in the selection. Comparing only the
	// sizes is not enough: after a list reload (deleted threads replaced by the next
	// page), a selection of old threads of the same size would check the box while no
	// row is checked, and a click would only "uncheck all".
	const visibleIds = mailboxThreads.map((t) => t.threadId);
	const isChecked =
		visibleIds.length > 0 &&
		visibleIds.every((id) => state?.selectedThreadIds?.has(id));

	// The selection only keeps displayed threads, otherwise an action (trash,
	// archive) would apply to threads that are no longer visible.
	// Exception: after "Select all N conversations", the selection deliberately covers
	// the threads of the other pages; it becomes a page selection again once cleared.
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
			toast.error(e?.message ?? "Selection failed", { position: "bottom-left" });
		} finally {
			setSelectingAll(false);
		}
	};
	const clearSelection = () =>
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
	const scopeLabel =
		selectAllScope?.kind === "search" ? "in this search" : `in ${activeMailbox?.name ?? "this folder"}`;

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

	const markRead = async () => {
		await markAsRead(
			Array.from(state?.selectedThreadIds ?? []),
			String(mailboxIdRef.current),
			!!mailboxSync,
			true,
		);
	};

	// The selection leaves the list on click, with an "Undo" toast; the server is only
	// called once the undo window has elapsed (see lib/pending-moves). On failure, the
	// threads come back with the error.
	const applyToSelection = (
		run: (ids: string[], mailboxId: string) => Promise<unknown>,
		done: (n: number) => string,
		archive = false,
	) => {
		const ids = Array.from(state?.selectedThreadIds ?? []).map(String);
		const mailboxId = String(mailboxIdRef.current);
		if (!ids.length) return;
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
		moveWithUndo({
			mailboxId,
			threadIds: ids,
			message: done(ids.length),
			run: () => run(ids, mailboxId),
			archive,
		});
	};
	const plural = (n: number) => (n > 1 ? `${n} conversations` : "Conversation");

	const deleteThreads = () => {
		if (mailboxKind.current === "trash") {
			removeTrash();
			return;
		}
		applyToSelection(
			(ids, mailboxId) => moveToTrash(ids, mailboxId, !!mailboxSync, true),
			(n) => `${plural(n)} moved to Trash`,
		);
	};

	const archiveThreads = () =>
		applyToSelection(
			(ids, mailboxId) => archiveThread(ids, mailboxId, !!mailboxSync, true),
			(n) => `${plural(n)} archived`,
			true,
		);

	// Spam page. Preselects the threads that are probably legitimate (sender already
	// seen outside Spam, or someone we have written to), then moves them back to the Inbox.
	const [triaging, setTriaging] = useState(false);
	const selectLikelyNotSpam = async () => {
		try {
			setTriaging(true);
			const found = new Set(await findLikelyNotSpam(String(mailboxIdRef.current)));
			const shown = mailboxThreads.map((t) => String(t.threadId)).filter((id) => found.has(id));
			setState((prev) => ({ ...prev, selectedThreadIds: new Set(shown) }));
			if (shown.length === 0) toast.info("No message here looks legitimate", { position: "bottom-left" });
			else toast.success(`${shown.length} message${shown.length > 1 ? "s" : ""} selected, check them before moving`, { position: "bottom-left" });
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
				moveToFolder(ids, mailboxId, String(inboxId), !!mailboxSync, true),
			(n) => `${plural(n)} moved to Inbox`,
		);
	};

	const removeTrash = () =>
		applyToSelection(
			(ids, mailboxId) => deleteForever(ids, mailboxId, !!mailboxSync, true),
			(n) => `${plural(n)} deleted forever`,
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
		toast.success("Trash removed successfully", { position: "bottom-left" });
	};

	const isMobile = useMediaQuery("(max-width: 768px)");
	const pathName = usePathname();
	const isOnSnoozedPage = pathName.split("/").includes("snoozed");

	return (
		<>
			<div className="sticky top-0 z-10 flex items-center bg-background/95 px-3 py-2 backdrop-blur rounded-t-2xl">
				{!isOnSnoozedPage && (
					<input
						type="checkbox"
						onChange={(e) => {
							// The box checks the threads of the page; unchecking after "all of the
							// folder" clears the whole selection.
							if (isChecked && allMatching) {
								clearSelection();
								return;
							}
							const newSet = new Set(state?.selectedThreadIds ?? []);
							if (!isChecked) {
								mailboxThreads.forEach((t) => newSet.add(t.threadId));
							} else {
								mailboxThreads.forEach((t) => newSet.delete(t.threadId));
							}
							setState((prev) => ({
								...(prev ?? {}),
								selectedThreadIds: newSet,
							}));
						}}
						checked={isChecked}
						aria-label="Select all"
						className="h-4 w-4 rounded border-muted-foreground/40"
					/>
				)}

				<div className="flex-1" />

				<div className="flex items-center gap-2 ml-auto">
					<Tooltip label="Sync" withArrow>
						<ActionIcon
							variant="subtle"
							onClick={reload}
							title="Sync"
							className="h-8 w-8"
						>
							<RotateCw className={reloading ? "animate-spin" : ""} size={16} />
						</ActionIcon>
					</Tooltip>
					{mailboxKind.current === "spam" && (
						<Tooltip
							label="Select messages that are probably not spam: sender already seen in Inbox, Archive or a folder, or someone you have written to"
							multiline
							w={260}
							withArrow
						>
							<Button
								size="xs"
								variant="subtle"
								loading={triaging}
								leftSection={<ListChecks size={16} />}
								onClick={selectLikelyNotSpam}
							>
								Select likely not spam
							</Button>
						</Tooltip>
					)}

					<div
						className={clsx(
							"inset-0 flex items-center gap-1 transition-opacity",
							hasSelected
								? "opacity-100"
								: "opacity-0 hidden pointer-events-none",
						)}
					>
						<MoveToFolder
							identityMailboxes={identityMailboxes}
							activeMailbox={activeMailbox}
						/>
						{mailboxKind.current === "spam" && inboxId && (
							<button
								type="button"
								onClick={notSpam}
								className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
								title="Not spam: move to Inbox"
							>
								<Inbox className="h-4 w-4" />
								Not spam
							</button>
						)}
						{mailboxKind.current !== "archive" && (
							<button
								type="button"
								onClick={archiveThreads}
								className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
								title="Archive"
								data-k-shortcut="selection-archive"
							>
								<Archive className="h-4 w-4" />
							</button>
						)}
						<button
							type="button"
							onClick={deleteThreads}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
							title="Delete"
							data-k-shortcut="selection-delete"
						>
							<Trash2 className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={markRead}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
							title="Mark read"
						>
							<MailOpen className="h-4 w-4" />
						</button>
					</div>

					{isMobile && <ComposeMail publicConfig={publicConfig} identityMailboxes={identityMailboxes} />}
				</div>
			</div>

			{/* Contextual banner, like Gmail: the page is checked, offer to select everything else. */}
			{!isOnSnoozedPage && isChecked && (hasMore || allMatching) && (
				<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-muted/60 px-3 py-1.5 text-xs">
					{allMatching ? (
						<>
							<span>
								{state?.allMatchingTruncated
									? `The ${selectedSize} most recent conversations ${scopeLabel} are selected (limit).`
									: `All ${selectedSize} conversations ${scopeLabel} are selected.`}
							</span>
							<button type="button" onClick={clearSelection} className="font-semibold text-brand hover:underline">
								Clear selection
							</button>
						</>
					) : (
						<>
							<span>All {visibleIds.length} conversations on this page are selected.</span>
							<button
								type="button"
								onClick={selectAllMatching}
								disabled={selectingAll}
								className="font-semibold text-brand hover:underline disabled:opacity-60"
								data-k-shortcut="selection-select-all-matching"
							>
								{selectingAll
									? "Selecting..."
									: totalThreads != null
										? `Select all ${totalThreads} conversations ${scopeLabel}`
										: `Select all conversations ${scopeLabel}`}
							</button>
						</>
					)}
				</div>
			)}

			{mailboxKind.current === "trash" && (
				<div
					className={
						"flex p-2 text-sm text-muted-foreground justify-center mb-3  mx-2 rounded items-center"
					}
				>
					<span>
						Messages that have been in the Trash for more than 30 days will be
						deleted automatically.
					</span>
					<AlertDialog>
						<AlertDialogTrigger asChild={true} className={"-mx-2"}>
							<Button variant={"transparent"}>Empty Bin Now</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
								<AlertDialogDescription>
									This action cannot be undone. This will permanently delete
									your account and remove your data from our servers.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={emptyTrash}>
									Continue
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			)}
		</>
	);
}

export default MailListHeader;
