"use client";
import React, { useRef, useEffect, useState } from "react";
import { Archive, Inbox, ListChecks, MailOpen, RotateCw, Trash2 } from "lucide-react";
import { findLikelyNotSpam } from "@/lib/actions/spam-triage";
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
}: {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
	activeMailbox: MailboxEntity;
	mailboxSync?: MailboxSyncEntity;
}) {
	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
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
	const isChecked =
		selectedSize === mailboxThreads.length && mailboxThreads.length > 0;

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

	const deleteThreads = async () => {
		if (mailboxKind.current === "trash") {
			await removeTrash();
			return;
		}
		await moveToTrash(
			Array.from(state?.selectedThreadIds ?? []),
			String(mailboxIdRef.current),
			!!mailboxSync,
			true,
		);
		toast.success("Messages moved to Trash", { position: "bottom-left" });
	};

	const archiveThreads = async () => {
		await archiveThread(
			Array.from(state?.selectedThreadIds ?? []),
			String(mailboxIdRef.current),
			!!mailboxSync,
			true,
		);
		toast.success("Messages archived", { position: "bottom-left" });
	};

	// ss2i : page Spam. Presélection des fils probablement legitimes (expediteur
	// deja vu hors spam ou a qui on a ecrit), puis renvoi en boite de reception.
	const [triaging, setTriaging] = useState(false);
	const selectLikelyNotSpam = async () => {
		try {
			setTriaging(true);
			const found = new Set(await findLikelyNotSpam(String(mailboxIdRef.current)));
			const shown = mailboxThreads.map((t) => String(t.threadId)).filter((id) => found.has(id));
			setState((prev) => ({ ...prev, selectedThreadIds: new Set(shown) }));
			if (shown.length === 0) toast.info("No message here looks legitimate", { position: "bottom-left" });
			else toast.success(`${shown.length} message(s) selected, check them before moving`, { position: "bottom-left" });
		} catch (e: any) {
			toast.error(e?.message ?? "Selection failed");
		} finally {
			setTriaging(false);
		}
	};
	const inboxId = identityMailboxes
		.find((im) => im.identity.id === activeMailbox?.identityId)
		?.mailboxes?.find((m: any) => m?.kind === "inbox")?.id;
	const notSpam = async () => {
		if (!inboxId) return;
		const ids = Array.from(state?.selectedThreadIds ?? []);
		await moveToFolder(ids, String(mailboxIdRef.current), String(inboxId), !!mailboxSync, true);
		setState((prev) => ({ ...prev, selectedThreadIds: new Set() }));
		toast.success("Moved to Inbox", { position: "bottom-left" });
	};

	const removeTrash = async () => {
		await deleteForever(
			Array.from(state?.selectedThreadIds ?? []),
			String(mailboxIdRef.current),
			!!mailboxSync,
			true,
		);
		toast.success("Thread deleted forever", { position: "bottom-left" });
	};

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
							const newSet = new Set(state?.selectedThreadIds ?? []);
							if (e.target.checked) {
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
							>
								<Archive className="h-4 w-4" />
							</button>
						)}
						<button
							type="button"
							onClick={deleteThreads}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
							title="Delete"
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
