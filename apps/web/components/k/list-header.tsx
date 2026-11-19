"use client";
import { mailboxTitle } from "@/components/k/format";
import { adjustCount, mailActions, scheduleRefresh, useMailStore } from "@/components/k/mail-store";
import MobileNavButton from "@/components/k/mobile-nav-button";
import React, { useRef, useEffect, useState } from "react";
import { Archive, Building2, Inbox, ListChecks, MailOpen, RotateCw, Trash2 } from "lucide-react";
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
import KArchiveFor from "@/components/k/archive-for";
import { PublicConfig } from "@schema";
import { useMediaQuery } from "@mantine/hooks";
import { clsx } from "clsx";
import MoveToFolder from "@/components/mailbox/default/move-to-folder";
import { LinkClientPicker } from "@/components/mailbox/default/client-link-ui";
import { useParams, usePathname } from "next/navigation";

// SS2i (nouvelle interface) : en-tete de la liste. Logique reprise telle quelle
// de mail-list-header.tsx (selection, « tout selectionner », Undo, spam, corbeille),
// presentation et textes de la nouvelle interface.
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
	// ss2i : « tout selectionner » au-dela de la page. Sans scope, pas de proposition.
	selectAllScope?: SelectAllScope;
	// Nombre total de fils s'il est connu (recherche), sinon mayHaveMore dit s'il y en a d'autres.
	totalThreads?: number;
	mayHaveMore?: boolean;
	// ss2i : titre propre aux ecrans hors dossier (recherche, libelle, client, reportes).
	title?: React.ReactNode;
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

	// ss2i : etat lu / non lu tel qu'affiche (actions instantanees du store comprises).
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
			toast.error(e?.message ?? "La sélection a échoué", { position: "bottom-center" });
		} finally {
			setSelectingAll(false);
		}
	};
	const clearSelection = () =>
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
	const scopeLabel =
		selectAllScope?.kind === "search" ? "de cette recherche" : `de « ${mailboxTitle(activeMailbox?.kind, activeMailbox?.name)} »`;

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

	// ss2i : la selection quitte la liste des le clic, toast avec « Undo » ; le serveur
	// n'est sollicite qu'a la fin de la fenetre d'annulation (cf. lib/pending-moves).
	// En cas d'echec, les fils reviennent avec l'erreur.
	// Avant : rien a l'ecran pendant de longues secondes, puis quelques fils seulement.
	const applyToSelection = (
		run: (ids: string[], mailboxId: string) => Promise<unknown>,
		done: (n: number) => string,
		// archiver ne fait que sortir le fil de l'Inbox (patch 0081)
		archive = false,
	) => {
		const ids = Array.from(state?.selectedThreadIds ?? []).map(String);
		const mailboxId = String(mailboxIdRef.current);
		if (!ids.length) return;
		setState((prev) => ({ ...prev, selectedThreadIds: new Set(), allMatching: false }));
		// compteur de la barre laterale : fils non lus qui quittent le dossier
		const unread = unreadAmong(ids);
		adjustCount(mailboxId, -unread);
		moveWithUndo({
			mailboxId,
			threadIds: ids,
			message: done(ids.length),
			onUndo: () => adjustCount(mailboxId, unread),
			archive,
			// ss2i (nouvelle interface) : actions sans attente du worker ni rendu complet
			// (refresh=false ci-dessous), puis rafraichissement discret.
			run: () => run(ids, mailboxId),
			onDone: () => scheduleRefresh(),
		});
	};
	const plural = (n: number) => (n > 1 ? `${n} fils` : "Fil");

	const deleteThreads = () => {
		if (mailboxKind.current === "trash") {
			removeTrash();
			return;
		}
		applyToSelection(
			(ids, mailboxId) => moveToTrash(ids, mailboxId, !!mailboxSync, false),
			(n) => `${plural(n)} dans la corbeille`,
		);
	};

	const archiveThreads = () =>
		applyToSelection(
			(ids, mailboxId) => archiveThread(ids, mailboxId, !!mailboxSync, false),
			(n) => `${plural(n)} archivé${n > 1 ? "s" : ""}`,
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
			if (shown.length === 0) toast.info("Aucun message ne semble légitime ici", { position: "bottom-center" });
			else toast.success(`${shown.length} message(s) sélectionné(s), vérifiez avant de déplacer`, { position: "bottom-center" });
		} catch (e: any) {
			toast.error(e?.message ?? "La sélection a échoué");
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
			(n) => `${plural(n)} remis en boîte de réception`,
		);
	};

	const removeTrash = () =>
		applyToSelection(
			(ids, mailboxId) => deleteForever(ids, mailboxId, !!mailboxSync, false),
			(n) => `${plural(n)} supprimé${n > 1 ? "s" : ""} définitivement`,
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
		toast.success("Corbeille vidée", { position: "bottom-center" });
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
								// La case coche les fils de la page ; decocher apres « tout le dossier » vide toute la selection.
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
							aria-label="Tout sélectionner"
							className="h-4 w-4 cursor-pointer accent-[var(--k-accent)]"
						/>
					</label>
				)}

				{hasSelected ? (
					<div className="k-fade-in flex min-w-0 flex-1 items-center gap-0.5">
						<span className="mr-1 whitespace-nowrap text-[13px] font-medium text-k-ink">
							{selectedSize} sélectionné{selectedSize > 1 ? "s" : ""}
						</span>
						<MoveToFolder identityMailboxes={identityMailboxes} activeMailbox={activeMailbox} />
						{/* ss2i (OI 10270) : rattacher la selection a un client (identites pro) */}
						<LinkClientPicker
							identityPublicId={String(routeParams.identityPublicId ?? state?.identityPublicId ?? "")}
							threadIds={() => Array.from(state?.selectedThreadIds ?? []).map(String)}
							onLinked={clearSelection}
							trigger={(open) => (
								<button type="button" onClick={open} className={bulkBtn} title="Rattacher à un client…">
									<Building2 className="h-4 w-4" />
								</button>
							)}
						/>
						{mailboxKind.current === "spam" && inboxId && (
							<button type="button" onClick={notSpam} className={bulkBtn} title="Pas un spam : remettre dans la boîte de réception">
								<Inbox className="h-4 w-4" />
								Pas un spam
							</button>
						)}
						{mailboxKind.current !== "archive" && (
							<button type="button" onClick={archiveThreads} className={bulkBtn} title="Archiver" data-ss2i-shortcut="selection-archive">
								<Archive className="h-4 w-4" />
							</button>
						)}
						<KArchiveFor
							mailboxId={String(mailboxIdRef.current)}
							mailboxKind={String(mailboxKind.current)}
							smtp={!!mailboxSync}
							threadIds={() => Array.from(state?.selectedThreadIds ?? []).map(String)}
							unread={() => unreadAmong(Array.from(state?.selectedThreadIds ?? []).map(String))}
							starred={() => {
								const ids = new Set(Array.from(state?.selectedThreadIds ?? []).map(String));
								return mailboxThreads.some((t) => ids.has(String(t.threadId)) && t.starred);
							}}
							before={clearSelection}
							bulkClassName={bulkBtn}
						/>
						<button type="button" onClick={markRead} className={bulkBtn} title="Marquer comme lu">
							<MailOpen className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={deleteThreads}
							className={`${bulkBtn} hover:!bg-k-danger-soft hover:!text-k-danger`}
							title={mailboxKind.current === "trash" ? "Supprimer définitivement" : "Supprimer"}
							data-ss2i-shortcut="selection-delete"
						>
							<Trash2 className="h-4 w-4" />
						</button>
						<button type="button" onClick={clearSelection} className={`${bulkBtn} ml-auto`}>
							Annuler
						</button>
					</div>
				) : (
					<>
						<div className="min-w-0 flex-1">
							<h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-k-ink">
								{title ?? mailboxTitle(activeMailbox.kind, activeMailbox.name)}
								{unreadInView > 0 && mailboxKind.current !== "trash" && (
									<span className="ml-2 text-[13px] font-normal text-k-ink-3">
										{unreadInView} non lu{unreadInView > 1 ? "s" : ""}
									</span>
								)}
							</h1>
						</div>

						{mailboxKind.current === "spam" && (
							<Tooltip
								label="Sélectionne les messages probablement légitimes : expéditeur déjà vu ailleurs que dans le spam, ou à qui vous avez écrit"
								multiline
								w={260}
								withArrow
							>
								<Button size="xs" variant="subtle" loading={triaging} leftSection={<ListChecks size={15} />} onClick={selectLikelyNotSpam}>
									Trier
								</Button>
							</Tooltip>
						)}

						<div className="flex rounded-k-sm bg-k-hover p-0.5 text-[12.5px]">
							{(
								[
									["all", "Tous"],
									["unread", "Non lus"],
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

						<Tooltip label="Synchroniser" withArrow openDelay={350} fz="xs">
							<button
								type="button"
								onClick={reload}
								aria-label="Synchroniser"
								className="flex h-8 w-8 items-center justify-center rounded-k-sm text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
							>
								<RotateCw className={reloading ? "animate-spin" : ""} size={15} />
							</button>
						</Tooltip>
					</>
				)}

				{isMobile && <KCompose publicConfig={publicConfig} identityMailboxes={identityMailboxes} />}
			</div>

			{/* Bandeau « tout selectionner » au-dela de la page (comme la classique). */}
			{!isOnSnoozedPage && isChecked && (hasMore || allMatching) && (
				<div className="mx-3 mb-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-k bg-k-accent-soft px-3 py-1.5 text-[12.5px] text-k-ink-2">
					{allMatching ? (
						<>
							<span>
								{state?.allMatchingTruncated
									? `Les ${selectedSize} fils les plus récents ${scopeLabel} sont sélectionnés (limite atteinte).`
									: `Les ${selectedSize} fils ${scopeLabel} sont sélectionnés.`}
							</span>
							<button type="button" onClick={clearSelection} className="font-semibold text-k-accent hover:underline">
								Effacer la sélection
							</button>
						</>
					) : (
						<>
							<span>Les {visibleIds.length} fils de cette page sont sélectionnés.</span>
							<button
								type="button"
								onClick={selectAllMatching}
								disabled={selectingAll}
								className="font-semibold text-k-accent hover:underline disabled:opacity-60"
								data-ss2i-shortcut="selection-select-all-matching"
							>
								{selectingAll
									? "Sélection…"
									: totalThreads != null
										? `Sélectionner les ${totalThreads} fils ${scopeLabel}`
										: `Sélectionner tous les fils ${scopeLabel}`}
							</button>
						</>
					)}
				</div>
			)}

			{mailboxKind.current === "trash" && (
				<div className="mx-3 mb-2 flex items-center gap-3 rounded-k bg-k-surface-2 px-3 py-2 text-[12.5px] text-k-ink-2">
					<span className="flex-1">Les messages de plus de 30 jours dans la corbeille sont supprimés automatiquement.</span>
					<AlertDialog>
						<AlertDialogTrigger asChild={true}>
							<button type="button" className="shrink-0 font-medium text-k-danger hover:underline">
								Vider la corbeille
							</button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Vider la corbeille ?</AlertDialogTitle>
								<AlertDialogDescription>
									Tous les messages de la corbeille seront supprimés définitivement, y compris sur le serveur. Cette action est irréversible.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Annuler</AlertDialogCancel>
								<AlertDialogAction onClick={emptyTrash}>Vider la corbeille</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			)}
		</>
	);
}

export default KListHeader;
