"use client";
import { stripSubjectPrefixes } from "@common/subject";

import * as React from "react";
import {
	CommandDialog,
	CommandInput,
	CommandSeparator,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Search, Paperclip, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import type { ThreadHit } from "@schema";
import { useShowSnippet } from "@/components/mailbox/default/list-preview-context";
import { initSearch } from "@/lib/actions/mailbox";
import { useRouter } from 'next/navigation'
import { selectedPageText } from "@/lib/page-selection";
import { Modal } from "@mantine/core";
import KCleanupRule from "@/components/k/cleanup-rule-form";

const DEBOUNCE_MS = 250;

export default function MailboxSearch({
										  publicId,
										  mailboxSlug: requestedSlug,
										  workspacePublicId,
										  nouvelle = false,
										  cleanup,
									  }: {
	publicId: string;
	mailboxSlug?: string;
	workspacePublicId: string;
	// ss2i : bouton d'ouverture au style de la nouvelle interface (option par utilisateur).
	nouvelle?: boolean;
	// ss2i : « Nettoyage auto... » (docs/plans/nettoyage-auto-recherche.md, MT11). Donne par le serveur au seul
	// proprietaire de l'identite (une regle est a son auteur) : sans lui, pas de bouton.
	cleanup?: { mailboxName: string; mailboxCleanable: boolean };
}) {

	// ss2i : les pages sans dossier (parametres, programmes, snoozes) n'ont pas de mailboxSlug
	// (URL .../undefined/search, erreur serveur « Mailbox not found ») et la vue Clients a le
	// slug virtuel « clients » (.../clients/search, « Unknown client. ») : la recherche part
	// alors de l'Inbox de l'identite.
	const mailboxSlug = !requestedSlug || requestedSlug === "undefined" || requestedSlug === "clients" ? "inbox" : requestedSlug;
	const k = (en: string, fr: string) => (nouvelle ? fr : en);
	const showSnippet = useShowSnippet();
	const [open, setOpen] = React.useState(false);
	const [query, setQuery] = React.useState("");
	const [hasAttachment, setHasAttachment] = React.useState(false);
	const [onlyUnread, setOnlyUnread] = React.useState(false);
	const [isStarred, setIsStarred] = React.useState(false);
	// ss2i : la recherche part du dossier courant ; si elle ne donne rien, un bouton l'etend a
	// tous les dossiers (sauf Corbeille et Spam). Chaque ouverture repart du dossier courant.
	const [allFolders, setAllFolders] = React.useState(false);
	React.useEffect(() => {
		if (open) setAllFolders(false);
	}, [open]);

	// ss2i : la regle de nettoyage part de la recherche telle qu'a l'ecran, prise au clic (la recherche se
	// ferme, la Modal Mantine ne tient pas dans le dialogue de la palette). Jamais d'etoile : un fil etoile
	// n'est jamais nettoye, le filtre « Favoris uniquement » desactive donc le bouton.
	const [cleanupOpen, setCleanupOpen] = React.useState(false);
	const [cleanupSnap, setCleanupSnap] = React.useState({ query: "", allFolders: false, hasAttachment: false, onlyUnread: false });

	const [loading, setLoading] = React.useState(false);
	const [items, setItems] = React.useState<ThreadHit[]>([]);
	const [totalThreads, setTotalThreads] = React.useState(0);
	const [totalMessages, setTotalMessages] = React.useState(0);

	// ss2i : texte selectionne dans la page = requete pre-remplie, selectionnee dans le champ
	// (onFocus) : Entree lance la recherche, une frappe ou Retour arriere la remplace, la croix
	// la vide. Le texte est lu a l'appui de la souris, avant que le clic ne defasse la selection ;
	// au clavier (« / », Ctrl+K) la selection est encore la au moment de l'ouverture.
	const openRef = React.useRef(open);
	openRef.current = open;
	const pressedSelection = React.useRef<string | null>(null);
	const inputRef = React.useRef<HTMLInputElement | null>(null);

	const openWithSelection = React.useCallback((captured?: string | null) => {
		const text = captured ?? selectedPageText();
		if (text) setQuery(text);
		setOpen(true);
	}, []);

	const triggerProps = {
		onMouseDown: () => {
			pressedSelection.current = selectedPageText();
		},
		onClick: () => {
			const captured = pressedSelection.current;
			pressedSelection.current = null;
			openWithSelection(captured);
		},
	};

	React.useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				if (openRef.current) setOpen(false);
				else openWithSelection();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openWithSelection]);

	React.useEffect(() => {
		const q = query.trim();
		if (!q) {
			setItems([]);
			setTotalThreads(0);
			setTotalMessages(0);
			return;
		}

		const t = setTimeout(async () => {
			try {
				setLoading(true);

				const res = await initSearch(
					q,
					workspacePublicId,
					publicId,
					mailboxSlug,
					hasAttachment,
					onlyUnread,
					isStarred,
					1,
					allFolders,
				);

				setItems(res.items || []);
				setTotalThreads(res.totalThreads ?? res.items?.length ?? 0);
				setTotalMessages(res.totalMessages ?? res.items?.length ?? 0);
			} catch {
				setItems([]);
				setTotalThreads(0);
				setTotalMessages(0);
			} finally {
				setLoading(false);
			}
		}, DEBOUNCE_MS);

		return () => clearTimeout(t);
	}, [
		query,
		hasAttachment,
		onlyUnread,
		isStarred,
		workspacePublicId,
		publicId,
		mailboxSlug,
		allFolders,
	]);

	const toggle = (setter: React.Dispatch<React.SetStateAction<boolean>>) =>
		setter((v) => !v);

	const pathName = usePathname();
	const inDashboard = pathName.includes("/dashboard/mail");

	const searchBase = inDashboard
		? `/w/${workspacePublicId}/dashboard/mail/${publicId}/${mailboxSlug}/search`
		: `/w/${workspacePublicId}/mail/${publicId}/${mailboxSlug}/search`;

	const threadBase = inDashboard
		? `/w/${workspacePublicId}/dashboard/mail/${publicId}/${mailboxSlug}/threads`
		: `/w/${workspacePublicId}/mail/${publicId}/${mailboxSlug}/threads`;
	// en recherche etendue, chaque fil s'ouvre dans son propre dossier
	const identityBase = inDashboard
		? `/w/${workspacePublicId}/dashboard/mail/${publicId}`
		: `/w/${workspacePublicId}/mail/${publicId}`;
	const threadHref = (t: ThreadHit) =>
		allFolders && t.mailboxSlug
			? `${identityBase}/${encodeURIComponent(t.mailboxSlug)}/threads/${t.threadId}`
			: `${threadBase}/${t.threadId}`;

	const router = useRouter()

	const cleanupBlocked = !cleanup
		? null
		: isStarred
			? "Un fil étoilé n'est jamais nettoyé : désactivez « Favoris uniquement »."
			: !allFolders && !cleanup.mailboxCleanable
				? "Ce dossier ne se nettoie pas : étendez la recherche à tous les dossiers."
				: null;

	return (
		<>
			{nouvelle ? (
				<button
					type="button"
					{...triggerProps}
					data-k-action="search"
					className="k-focus flex h-9 w-full items-center gap-2 rounded-k bg-k-hover px-3 text-k-ink-3 transition-colors hover:text-k-ink-2"
				>
					<Search className="h-4 w-4" />
					<span className="flex-1 text-left text-[13.5px]">Rechercher</span>
					<kbd className="rounded border border-k-line-strong bg-k-surface px-1.5 font-mono text-[11px] leading-5">/</kbd>
				</button>
			) : (
			<button
				type="button"
				{...triggerProps}
				// ss2i : sur mobile, le bouton prend la place restante sur une seule ligne (il passait
				// sur trois lignes et doublait la hauteur de la barre du haut).
				className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-muted-foreground hover:bg-muted/30 md:px-4 md:py-2.5"
			>
				<Search className="h-4 w-4 shrink-0 opacity-60" />
				<span className="truncate text-sm">
					Search<span className="hidden sm:inline"> this mailbox</span>
					<span className="hidden md:inline"> (⌘K)</span>
				</span>
			</button>
			)}

			<CommandDialog
				open={open}
				onOpenChange={setOpen}
				title={k("Command Palette", "Recherche dans le courrier")}
				description={k("Search for a command to run...", "Saisissez votre recherche, puis appuyez sur Entrée.")}
				// ss2i : la croix de fermeture tombait sur le champ ; Echap ferme, la croix du champ vide la requete.
				showCloseButton={false}
			>
				<div className="relative">
				<CommandInput
					ref={inputRef}
					className="pr-9"
					autoFocus
					placeholder={k("Search mail…", "Rechercher dans le courrier…")}
					value={query}
					onValueChange={setQuery}
					// ss2i : requete precedente selectionnee a l'ouverture : une nouvelle frappe la remplace
					// au lieu de s'y ajouter, les fleches permettent encore de l'affiner.
					onFocus={(e) => e.currentTarget.select()}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						// la page de resultats ne couvre que le dossier courant : en recherche
						// etendue, les resultats restent dans la modale
						if (allFolders) return;
						setOpen(false);
						router.push(
							`/w/${workspacePublicId}/${pathName.match("/dashboard/mail") ? "/dashboard" : ""}/mail/${publicId}/${mailboxSlug}/search?q=${encodeURIComponent(query)}&has=${hasAttachment ? "1" : "0"}&unread=${onlyUnread ? "1" : "0"}&starred=${isStarred ? "1" : "0"}`,
						);
					}}
				/>
				{query && (
					<button
						type="button"
						aria-label={k("Clear search", "Effacer la recherche")}
						title={k("Clear search", "Effacer la recherche")}
						data-ss2i="search-clear"
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => {
							setQuery("");
							inputRef.current?.focus();
						}}
						className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				)}
				</div>

				<div className="sticky top-0 z-10 flex flex-wrap gap-2 border-b bg-background px-4 py-2">
					<Badge
						onClick={() => toggle(setHasAttachment)}
						className={`cursor-pointer rounded-full px-3 py-1 text-sm ${
							hasAttachment ? "bg-primary text-primary-foreground" : ""
						}`}
						variant={hasAttachment ? "default" : "secondary"}
					>
						{k("Has attachment", "Avec pièce jointe")}
					</Badge>

					<Badge
						onClick={() => toggle(setOnlyUnread)}
						className={`cursor-pointer rounded-full px-3 py-1 text-sm ${
							onlyUnread ? "bg-primary text-primary-foreground" : ""
						}`}
						variant={onlyUnread ? "default" : "secondary"}
					>
						{k("Unread only", "Non lus uniquement")}
					</Badge>

					<Badge
						onClick={() => toggle(setIsStarred)}
						className={`cursor-pointer rounded-full px-3 py-1 text-sm ${
							isStarred ? "bg-primary text-primary-foreground" : ""
						}`}
						variant={isStarred ? "default" : "secondary"}
					>
						{k("Starred only", "Favoris uniquement")}
					</Badge>
				</div>

				<div className="px-4 py-2 text-xs text-muted-foreground">
					{loading
						? k("Searching…", "Recherche en cours…")
						: k(`Threads: ${totalThreads} · Messages: ${totalMessages}`, `Fils : ${totalThreads} · Messages : ${totalMessages}`) +
							(allFolders ? k(" · all folders", " · tous les dossiers") : "")}
				</div>

				{cleanup && query.trim() && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 pb-2 text-xs text-muted-foreground">
						<button
							type="button"
							data-ss2i="search-cleanup"
							disabled={!!cleanupBlocked}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								setCleanupSnap({ query: query.trim(), allFolders, hasAttachment, onlyUnread });
								setOpen(false);
								setCleanupOpen(true);
							}}
							className="rounded-md border px-3 py-1 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
						>
							Nettoyage auto...
						</button>
						{cleanupBlocked && <span data-ss2i="search-cleanup-reason">{cleanupBlocked}</span>}
					</div>
				)}

				<div className="max-h-[60vh] overflow-auto px-2 pb-2">
					{items.length === 0 && !loading ? (
						<div className="px-4 py-8 text-center text-sm text-muted-foreground">
							{allFolders
								? k("No results in any folder.", "Aucun résultat dans aucun dossier.")
								: k("No results in this folder.", "Aucun résultat dans ce dossier.")}
							{!allFolders && query.trim() && (
								<div className="mt-3">
									<button
										type="button"
										data-ss2i="search-all-folders"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => {
											setAllFolders(true);
											inputRef.current?.focus();
										}}
										className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
									>
										{k("Search all folders", "Étendre la recherche à tous les dossiers")}
									</button>
								</div>
							)}
						</div>
					) : (
						<ul className="space-y-2">
							{items.map((t) => (
								<li key={t.id} className="my-2">
									<Link
										href={threadHref(t)}
										className="block w-full rounded-md px-4 py-3 text-left hover:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-ring"
										onClick={() => setOpen(false)}
									>
										<div className="flex items-center gap-2">
											<span className="mt-0.5 flex">
												{t.starred ? (
													<IconStarFilled className="text-yellow-400" size={12} />
												) : (
													<IconStar className="h-3 w-3" />
												)}
											</span>

											<span
												aria-hidden
												className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
													t.unread ? "bg-primary" : "bg-muted-foreground/30"
												}`}
											/>

											<div className="truncate text-[15px] font-medium">
												{stripSubjectPrefixes(t.subject) || k("(no subject)", "(sans objet)")}
											</div>

											{t.hasAttachment && (
												<span className="ml-1 text-muted-foreground">
													<Paperclip className="h-3.5 w-3.5" />
												</span>
											)}

											{allFolders && t.mailboxName && (
												<span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
													{t.mailboxName}
												</span>
											)}
										</div>

										{showSnippet && t.snippet && (
											<div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
												{t.snippet}
											</div>
										)}

										<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
											{t.fromName ? (
												<span className="truncate">{t.fromName}</span>
											) : t.fromEmail ? (
												<span className="truncate">{t.fromEmail}</span>
											) : null}

											{t.participants?.length > 0 && (
												<>
													<span>•</span>
													<span className="truncate">
														{t.participants.slice(0, 2).join(", ")}
														{t.participants.length > 2 ? " …" : ""}
													</span>
												</>
											)}

											{t.createdAt ? (
												<div className="flex min-w-16">
													<span>•&nbsp;</span>
													<span>
														{new Date(t.createdAt).toLocaleDateString(undefined, {
															month: "short",
															day: "numeric",
														})}
													</span>
												</div>
											) : null}
										</div>
									</Link>
								</li>
							))}
						</ul>
					)}
				</div>

				<CommandSeparator />

				<div className="flex items-center justify-between rounded-b-lg bg-background/95 px-4 py-3 backdrop-blur">
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Search className="h-4 w-4 opacity-70" />
						<span>
							{k("All search results for", "Tous les résultats pour")}{" "}
							<span className="font-medium text-foreground">{`‘${query || ""}’`}</span>
						</span>
					</div>
					<div className="text-xs text-muted-foreground">
						{allFolders ? k("All folders", "Tous les dossiers") : k("Press ENTER", "Appuyez sur Entrée")}
					</div>
				</div>
			</CommandDialog>

			{cleanup && (
				<Modal
					centered
					opened={cleanupOpen}
					onClose={() => setCleanupOpen(false)}
					title={<span className="text-[15px] font-semibold">Nettoyage automatique</span>}
					size="md"
					zIndex={1003}
				>
					<KCleanupRule
						identityPublicId={publicId}
						mailboxSlug={mailboxSlug}
						mailboxName={cleanup.mailboxName}
						allFolders={cleanupSnap.allFolders}
						query={cleanupSnap.query}
						hasAttachment={cleanupSnap.hasAttachment}
						onlyUnread={cleanupSnap.onlyUnread}
						onDone={() => setCleanupOpen(false)}
					/>
				</Modal>
			)}
		</>
	);
}
