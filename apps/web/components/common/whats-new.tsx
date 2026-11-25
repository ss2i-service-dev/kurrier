"use client";

// ss2i (OI 10363) : modale « Nouveautes », sur le modele de Docator. Le fournisseur est pose
// une fois dans le layout du tableau de bord (les deux interfaces) ; le bouton
// <WhatsNewButton> se place dans la barre laterale de chacune. La modale s'ouvre seule
// quand une note n'a pas ete vue, sur la plus recente ; la note est marquee vue cote
// serveur des l'ouverture (lib/actions/changelogs.ts), donc ni F5 ni un autre poste ne la
// rouvrent. Couleurs herities de la fenetre Mantine : clair et sombre, Gmail et Outlook.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button, Modal, Tooltip } from "@mantine/core";
import { ChevronLeft, ChevronRight, Megaphone } from "lucide-react";
import { markChangelogSeen } from "@/lib/actions/changelogs";
import { unseenCount, versionDateLabel, type ChangelogEntry } from "@/lib/changelogs";
import { parseMarkdown, type Block, type Inline } from "@/lib/changelog-markdown";

type WhatsNewState = { unseen: number; total: number; open: () => void };

const WhatsNewContext = createContext<WhatsNewState>({ unseen: 0, total: 0, open: () => {} });

export function WhatsNewProvider({
	entries,
	lastSeen: initialSeen,
	children,
}: {
	entries: ChangelogEntry[];
	lastSeen: string | null;
	children: React.ReactNode;
}) {
	const [lastSeen, setLastSeen] = useState(initialSeen);
	const [opened, setOpened] = useState(false);
	// 0 = la plus recente ; « Precedent » remonte dans le temps.
	const [index, setIndex] = useState(0);
	const autoOpened = useRef(false);
	const unseen = unseenCount(entries, lastSeen);

	const open = useCallback(() => {
		if (!entries.length) return;
		setIndex(0);
		setOpened(true);
		const newest = entries[0].version;
		// Vu des l'ouverture. En cas d'echec la pastille reste, rien d'autre ne casse.
		if (unseenCount(entries, lastSeen) > 0) {
			markChangelogSeen(newest)
				.then((r) => r.success && setLastSeen(r.lastSeen ?? newest))
				.catch(() => {});
		}
	}, [entries, lastSeen]);

	// Ouverture automatique, une seule fois par chargement de page.
	useEffect(() => {
		if (autoOpened.current || unseen === 0) return;
		autoOpened.current = true;
		open();
	}, [unseen, open]);

	const entry = entries[index];
	return (
		<WhatsNewContext.Provider value={{ unseen, total: entries.length, open }}>
			{children}
			{entry && (
				<Modal
					opened={opened}
					onClose={() => setOpened(false)}
					centered
					size="lg"
					title={
						<span className="font-semibold">
							Nouveautés
							<span className="ml-2 text-xs font-normal opacity-60">version {process.env.NEXT_PUBLIC_BUILD_VERSION}</span>
						</span>
					}
				>
					<div className="text-xs opacity-60">
						{versionDateLabel(entry.version)} · {entries.length - index} / {entries.length}
					</div>
					<h2 className="mb-1 mt-1 text-lg font-semibold leading-snug">{entry.title}</h2>
					<div className="max-h-[60vh] overflow-y-auto pr-1" key={entry.version}>
						<Markdown source={entry.markdown} />
					</div>
					<div className="mt-4 flex items-center justify-between gap-2 border-t border-current/10 pt-3">
						<Button
							variant="default"
							size="xs"
							leftSection={<ChevronLeft size={14} />}
							disabled={index >= entries.length - 1}
							onClick={() => setIndex((i) => i + 1)}
						>
							Précédent
						</Button>
						<Button
							variant="default"
							size="xs"
							rightSection={<ChevronRight size={14} />}
							disabled={index <= 0}
							onClick={() => setIndex((i) => i - 1)}
						>
							Suivant
						</Button>
					</div>
				</Modal>
			)}
		</WhatsNewContext.Provider>
	);
}

export function useWhatsNew() {
	return useContext(WhatsNewContext);
}

/**
 * Bouton « Nouveautes » avec la pastille des notes non vues. `classic` : barre laterale de
 * l'interface Gmail (meme gabarit que ses boutons) ; `k` : colonne des espaces d'Outlook.
 */
export function WhatsNewButton({ variant }: { variant: "classic" | "k" }) {
	const { unseen, total, open } = useWhatsNew();
	if (!total) return null;
	const badge =
		unseen > 0 ? (
			<span
				data-testid="whats-new-badge"
				className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${
					variant === "k" ? "bg-k-accent text-k-accent-ink" : "bg-red-600 text-white"
				}`}
			>
				{unseen}
			</span>
		) : null;
	const label = unseen > 0 ? `Nouveautés (${unseen} non vue${unseen > 1 ? "s" : ""})` : "Nouveautés";
	if (variant === "k") {
		return (
			<Tooltip label={label} position="right" openDelay={250} withArrow>
				<button
					type="button"
					aria-label={label}
					onClick={open}
					className="k-focus relative flex w-9 shrink-0 flex-col items-center gap-0.5 rounded-k-sm py-1.5 text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink"
				>
					<Megaphone size={17} />
					{badge}
				</button>
			</Tooltip>
		);
	}
	return (
		<Tooltip label={label} position="right" openDelay={250} withArrow>
			<button
				type="button"
				aria-label={label}
				onClick={open}
				className="relative flex size-8 items-center justify-center rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
			>
				<Megaphone className="size-4" />
				{badge}
			</button>
		</Tooltip>
	);
}

function Inlines({ nodes }: { nodes: Inline[] }) {
	return (
		<>
			{nodes.map((n, i) => {
				switch (n.t) {
					case "text":
						return <React.Fragment key={i}>{n.v}</React.Fragment>;
					case "strong":
						return <strong key={i}><Inlines nodes={n.c} /></strong>;
					case "em":
						return <em key={i}><Inlines nodes={n.c} /></em>;
					case "code":
						return <code key={i} className="rounded bg-black/5 px-1 py-0.5 text-[0.9em] dark:bg-white/10">{n.v}</code>;
					case "link":
						return (
							<a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
								<Inlines nodes={n.c} />
							</a>
						);
				}
			})}
		</>
	);
}

function Markdown({ source }: { source: string }) {
	const blocks: Block[] = parseMarkdown(source);
	return (
		<div className="text-sm leading-relaxed">
			{blocks.map((b, i) => {
				switch (b.t) {
					case "heading":
						return (
							<h3 key={i} className="mb-2 mt-5 text-[15px] font-semibold first:mt-2">
								<Inlines nodes={b.c} />
							</h3>
						);
					case "p":
						return <p key={i} className="my-2"><Inlines nodes={b.c} /></p>;
					case "quote":
						return (
							<blockquote key={i} className="my-2 border-l-2 border-current/30 pl-3 opacity-80">
								<Inlines nodes={b.c} />
							</blockquote>
						);
					case "hr":
						return <hr key={i} className="my-4 border-current/15" />;
					case "list": {
						const List = b.ordered ? "ol" : "ul";
						return (
							<List key={i} className={`my-2 space-y-1.5 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}>
								{b.items.map((it, j) => (
									<li key={j}><Inlines nodes={it} /></li>
								))}
							</List>
						);
					}
				}
			})}
		</div>
	);
}
