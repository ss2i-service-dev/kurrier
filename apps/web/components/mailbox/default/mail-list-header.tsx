"use client";
import React, { useRef, useEffect, useState } from "react";
import { Archive, Building2, Inbox, ListChecks, MailOpen, RotateCw, Trash2, X } from "lucide-react";
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
import KArchiveFor from "@/components/k/archive-for";
import { LinkClientPicker } from "@/components/mailbox/default/client-link-ui";
import { useParams, usePathname } from "next/navigation";

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
	// ss2i : « tout selectionner » au-dela de la page. Sans scope, pas de proposition.
	selectAllScope?: SelectAllScope;
	// Nombre total de fils s'il est connu (recherche), sinon mayHaveMore dit s'il y en a d'autres.
	totalThreads?: number;
	mayHaveMore?: boolean;
}) {
	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
		// ss2i : la selection couvre tout le dossier ou toute la recherche, pages invisibles comprises.
		allMatching?: boolean;
		// Plafond atteint : seuls les plus recents sont selectionnes.
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

	const routeParams = useParams<{ identityPublicId?: string }>() ?? {};
	const selectedSize = state?.selectedThreadIds?.size ?? 0;
	const hasSelected = selectedSize > 0;
	// ss2i : « tout coche » = chaque fil affiche est dans la selection. Avant, on comparait
	// seulement les tailles : apres un rechargement de la liste (fils supprimes remplaces
	// par la page suivante), une selection d'anciens fils de meme taille cochait la case
	// sans qu'aucune ligne ne le soit, et un clic ne faisait plus que « tout decocher ».
	const visibleIds = mailboxThreads.map((t) => t.threadId);
	const isChecked =
		visibleIds.length > 0 &&
		visibleIds.every((id) => state?.selectedThreadIds?.has(id));

	// ss2i : la selection ne garde que des fils affiches, sinon une action (corbeille,
	// archive) partirait sur des fils que l'on ne voit plus.
	// Exception : apres « Select all N conversations », la selection couvre volontairement
	// les fils des autres pages ; elle redevient une selection de page une fois videe.
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

	// ss2i : l'action prise en compte, la selection se vide aussitot (Samuel le 06/11 :
	// « une fois que l'action est prise en compte, il faut virer la selection »).
	// Avant : on attendait le serveur et les fils restaient coches.
	const markRead = async () => {
		const ids = Array.from(state?.selectedThreadIds ?? []);
		if (!ids.length) return;
		clearSelection();
		try {
			await markAsRead(ids, String(mailboxIdRef.current), !!mailboxSync, true);
		} catch (e: any) {
			toast.error(e?.message ?? "Mark read failed", { position: "bottom-left" });
		}
	};

	// ss2i : la selection quitte la liste des le clic, toast avec « Undo » ; le serveur
	// n'est sollicite qu'a la fin de la fenetre d'annulation (cf. lib/pending-moves).
	// En cas d'echec, les fils reviennent avec l'erreur.
	// Avant : rien a l'ecran pendant de longues secondes, puis quelques fils seulement.
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
			{/* ss2i : collee sous la barre du haut (recherche, identite), elle-meme collante : en top-0
			    elle passait dessous des le premier defilement et ses actions disparaissaient. */}
			<div className="sticky top-[var(--ss2i-mail-header-h,0px)] z-10 flex flex-wrap items-center bg-background/95 px-3 py-2 backdrop-blur rounded-t-2xl">
				{!isOnSnoozedPage && (
					<input
						type="checkbox"
						onChange={(e) => {
							// ss2i : la case coche les fils de la page ; decocher apres « tout le
							// dossier » vide toute la selection.
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
						data-ss2i-shortcut="select-all"
						className="h-4 w-4 rounded border-muted-foreground/40"
					/>
				)}
				{/* ss2i : tout deselectionner en un clic, sans passer par la case « tout
				    selectionner » puis la decocher (Samuel le 06/11). */}
				{!isOnSnoozedPage && hasSelected && (
					<button
						type="button"
						onClick={clearSelection}
						className="ml-2 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"
						title="Deselect all"
						data-ss2i-shortcut="selection-clear"
					>
						<X className="h-4 w-4" />
						{selectedSize} selected
					</button>
				)}

				<div className="flex-1" />

				<div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 ml-auto">
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
							"inset-0 flex flex-wrap items-center gap-1 transition-opacity",
							hasSelected
								? "opacity-100"
								: "opacity-0 hidden pointer-events-none",
						)}
					>
						<MoveToFolder
							identityMailboxes={identityMailboxes}
							activeMailbox={activeMailbox}
						/>
						{/* ss2i (OI 10270) : rattacher la selection a un client (identites pro) */}
						<LinkClientPicker
							identityPublicId={String(routeParams.identityPublicId ?? "")}
							threadIds={() => Array.from(state?.selectedThreadIds ?? []).map(String)}
							onLinked={clearSelection}
							trigger={(open) => (
								<button
									type="button"
									onClick={open}
									className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
									title="Link to a client"
								>
									<Building2 className="h-4 w-4" />
									Client
								</button>
							)}
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
								data-ss2i-shortcut="selection-archive"
							>
								<Archive className="h-4 w-4" />
							</button>
						)}
						{/* ss2i : « Archiver pour… » (ou « Durée de vie… » dans l'Archive), meme composant que la nouvelle interface. */}
						<KArchiveFor
							mailboxId={String(mailboxIdRef.current)}
							mailboxKind={String(mailboxKind.current)}
							smtp={!!mailboxSync}
							threadIds={() => Array.from(state?.selectedThreadIds ?? []).map(String)}
							starred={() => {
								const ids = new Set(Array.from(state?.selectedThreadIds ?? []).map(String));
								return mailboxThreads.some((t) => ids.has(String(t.threadId)) && t.starred);
							}}
							before={clearSelection}
							bulkClassName="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
							shortcut="selection"
						/>
						<button
							type="button"
							onClick={deleteThreads}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
							title="Delete"
							data-ss2i-shortcut="selection-delete"
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

			{/* ss2i : bandeau contextuel, comme Gmail : la page est cochee, proposer tout le reste. */}
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
								data-ss2i-shortcut="selection-select-all-matching"
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
