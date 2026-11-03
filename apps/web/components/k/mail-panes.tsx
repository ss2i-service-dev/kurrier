"use client";
// SS2i : les deux colonnes de travail. La liste garde sa largeur et son
// defilement quand un fil s'ouvre a droite ; sur mobile une seule est visible.
import React, { startTransition, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { registerRefresher, setActiveThread, setComposeSlot, useMailStore } from "@/components/k/mail-store";
import { Inbox } from "lucide-react";

export const isThreadPath = (p?: string | null) => /\/threads\/[^/]+/.test(p ?? "");

export default function MailPanes({ list, reader }: { list: React.ReactNode; reader: React.ReactNode }) {
	const pathname = usePathname();
	const onThread = isThreadPath(pathname);
	const composingRaw = useMailStore((s) => s.composing);
	const parked = useMailStore((s) => s.composeParked);
	// Envoi annulable en cours : le panneau revient au fil ou a l'ecran vide,
	// l'editeur reste monte (cache) pour que « Annuler l'envoi » fonctionne.
	const composing = composingRaw && !parked;
	const router = useRouter();
	// Rafraichissement differe apres une salve d'actions optimistes, en transition
	// (non bloquant). Et fin de « l'ouverture en cours » quand l'URL a change.
	useEffect(() => registerRefresher(() => startTransition(() => router.refresh())), [router]);
	useEffect(() => setActiveThread(pathname?.match(/\/threads\/([^/]+)/)?.[1] ?? null), [pathname]);
	return (
		<div className="flex min-w-0 flex-1 gap-2">
			<section
				aria-label="Messages"
				className={`${onThread || composing ? "hidden lg:flex" : "flex"} w-full min-w-0 flex-col overflow-hidden bg-k-surface md:rounded-k-pane md:shadow-k-pane lg:w-[400px] lg:shrink-0 xl:w-[440px]`}
			>
				{list}
			</section>
			<section
				aria-label="Lecture"
				className={`${onThread || composing ? "flex" : "hidden lg:flex"} min-w-0 flex-1 flex-col overflow-hidden bg-k-surface md:rounded-k-pane md:shadow-k-pane`}
			>
				{/* Nouveau message : l'editeur (compose-mail.tsx) s'affiche ici par portail. */}
				{composingRaw && (
					<div ref={setComposeSlot} data-k-compose className={composing ? "flex min-h-0 flex-1 flex-col" : "hidden"} />
				)}
				{!composing && (onThread ? reader : <EmptyReader />)}
			</section>
		</div>
	);
}

function EmptyReader() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3">
				<Inbox size={24} strokeWidth={1.6} />
			</div>
			<div>
				<p className="text-[15px] font-medium text-k-ink">Aucun message sélectionné</p>
				<p className="mt-1 text-[13px] text-k-ink-3">
					Choisissez un fil dans la liste, ou appuyez sur{" "}
					<kbd className="rounded border border-k-line-strong px-1.5 font-mono text-[11px]">C</kbd> pour écrire.
				</p>
			</div>
		</div>
	);
}
