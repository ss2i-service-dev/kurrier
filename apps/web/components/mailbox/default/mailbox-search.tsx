"use client";

import { useStripSubjectPrefixes } from "@/components/mailbox/default/compose-style-context";
import { subjectForDisplay } from "@common/subject";
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

const DEBOUNCE_MS = 250;

export default function MailboxSearch({
										  publicId,
										  mailboxSlug: requestedSlug,
										  workspacePublicId,
										  modern = false,
									  }: {
	publicId: string;
	mailboxSlug?: string;
	workspacePublicId: string;
	// Trigger button styled for the modern interface (per-user option).
	modern?: boolean;
}) {
	const stripPrefixes = useStripSubjectPrefixes();

	// Pages without a folder (settings, scheduled, snoozed) have no mailboxSlug
	// (URL .../undefined/search, server error "Mailbox not found"): the search then
	// starts from the identity's Inbox.
	const mailboxSlug = !requestedSlug || requestedSlug === "undefined" ? "inbox" : requestedSlug;
	const showSnippet = useShowSnippet();
	const [open, setOpen] = React.useState(false);
	const [query, setQuery] = React.useState("");
	const [hasAttachment, setHasAttachment] = React.useState(false);
	const [onlyUnread, setOnlyUnread] = React.useState(false);
	const [isStarred, setIsStarred] = React.useState(false);

	const [loading, setLoading] = React.useState(false);
	const [items, setItems] = React.useState<ThreadHit[]>([]);
	const [totalThreads, setTotalThreads] = React.useState(0);
	const [totalMessages, setTotalMessages] = React.useState(0);

	// Text selected in the page = prefilled query, selected in the field (onFocus):
	// Enter runs the search, a keystroke or Backspace replaces it, the cross clears it.
	// The text is read on mouse down, before the click drops the selection; with the
	// keyboard ("/", Ctrl+K) the selection is still there when the dialog opens.
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

	const router = useRouter()

	return (
		<>
			{modern ? (
				<button
					type="button"
					{...triggerProps}
					data-k-action="search"
					className="k-focus flex h-9 w-full items-center gap-2 rounded-k bg-k-hover px-3 text-k-ink-3 transition-colors hover:text-k-ink-2"
				>
					<Search className="h-4 w-4" />
					<span className="flex-1 text-left text-[13.5px]">Search</span>
					<kbd className="rounded border border-k-line-strong bg-k-surface px-1.5 font-mono text-[11px] leading-5">/</kbd>
				</button>
			) : (
			<button
				type="button"
				{...triggerProps}
				className="flex w-full items-center gap-2 rounded-lg border bg-background px-4 py-2.5 text-muted-foreground hover:bg-muted/30"
			>
				<Search className="h-4 w-4 opacity-60" />
				<span className="text-sm">Search this mailbox (⌘K)</span>
			</button>
			)}

			<CommandDialog
				open={open}
				onOpenChange={setOpen}
				title={"Command Palette"}
				description={"Search for a command to run..."}
				// The close cross overlapped the input; Escape closes, the input's cross clears the query.
				showCloseButton={false}
			>
				<div className="relative">
				<CommandInput
					ref={inputRef}
					className="pr-9"
					autoFocus
					placeholder={"Search mail…"}
					value={query}
					onValueChange={setQuery}
					// Previous query selected on open: a new keystroke replaces it instead of
					// appending to it, the arrow keys still allow refining it.
					onFocus={(e) => e.currentTarget.select()}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						setOpen(false);
						router.push(
							`/w/${workspacePublicId}/${pathName.match("/dashboard/mail") ? "/dashboard" : ""}/mail/${publicId}/${mailboxSlug}/search?q=${encodeURIComponent(query)}&has=${hasAttachment ? "1" : "0"}&unread=${onlyUnread ? "1" : "0"}&starred=${isStarred ? "1" : "0"}`,
						);
					}}
				/>
				{query && (
					<button
						type="button"
						aria-label={"Clear search"}
						title={"Clear search"}
						data-k="search-clear"
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
						{"Has attachment"}
					</Badge>

					<Badge
						onClick={() => toggle(setOnlyUnread)}
						className={`cursor-pointer rounded-full px-3 py-1 text-sm ${
							onlyUnread ? "bg-primary text-primary-foreground" : ""
						}`}
						variant={onlyUnread ? "default" : "secondary"}
					>
						{"Unread only"}
					</Badge>

					<Badge
						onClick={() => toggle(setIsStarred)}
						className={`cursor-pointer rounded-full px-3 py-1 text-sm ${
							isStarred ? "bg-primary text-primary-foreground" : ""
						}`}
						variant={isStarred ? "default" : "secondary"}
					>
						{"Starred only"}
					</Badge>
				</div>

				<div className="px-4 py-2 text-xs text-muted-foreground">
					{loading
						? "Searching…"
						: `Threads: ${totalThreads} · Messages: ${totalMessages}`}
				</div>

				<div className="max-h-[60vh] overflow-auto px-2 pb-2">
					{items.length === 0 && !loading ? (
						<div className="px-4 py-8 text-center text-sm text-muted-foreground">
							{"No results found."}
						</div>
					) : (
						<ul className="space-y-2">
							{items.map((t) => (
								<li key={t.id} className="my-2">
									<Link
										href={`${threadBase}/${t.threadId}`}
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
												{subjectForDisplay(t.subject, stripPrefixes) || "(no subject)"}
											</div>

											{t.hasAttachment && (
												<span className="ml-1 text-muted-foreground">
													<Paperclip className="h-3.5 w-3.5" />
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
							{"All search results for"}{" "}
							<span className="font-medium text-foreground">{`‘${query || ""}’`}</span>
						</span>
					</div>
					<div className="text-xs text-muted-foreground">{"Press ENTER"}</div>
				</div>
			</CommandDialog>
		</>
	);
}
