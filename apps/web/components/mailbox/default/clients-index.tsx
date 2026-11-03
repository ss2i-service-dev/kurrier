"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { ClientRow } from "@/lib/actions/thread-clients";
import { useNouvelle } from "@/components/k/ui-context";
import { KEmptyState } from "@/components/k/section";
import { Building2, Search } from "lucide-react";

// ss2i clients : table des clients d'une identite pro (nom, fils, derniere activite,
// fiche CRM), filtre par nom cote navigateur : la liste est deja en memoire.
export default function ClientsIndex({
	clients,
	identityPublicId,
	workspacePublicId,
}: {
	clients: (ClientRow & { crmUrl: string })[];
	identityPublicId: string;
	workspacePublicId: string;
}) {
	const [filter, setFilter] = useState("");
	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return needle ? clients.filter((c) => c.name.toLowerCase().includes(needle)) : clients;
	}, [clients, filter]);
	const base = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/clients`;
	const nouvelle = useNouvelle();

	// ss2i : nouvelle interface : filtre et lignes dans le style de la messagerie.
	if (nouvelle) {
		if (clients.length === 0) {
			return (
				<KEmptyState
					icon={<Building2 size={22} strokeWidth={1.6} />}
					title="Aucun client pour l'instant"
					text="Les fils sont rattachés aux entreprises du CRM à mesure que les messages arrivent ; l'historique est traité en arrière-plan."
				/>
			);
		}
		return (
			<div className="space-y-2 px-3 pb-4">
				<label className="relative block max-w-sm">
					<Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-k-ink-3" />
					<input
						type="text"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filtrer par nom"
						className="h-8 w-full rounded-k-sm border border-k-line-strong bg-k-surface pl-8 pr-3 text-[13px] text-k-ink outline-none placeholder:text-k-ink-3 focus:border-k-accent"
					/>
				</label>
				<div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 px-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">
					<span>Client</span>
					<span className="w-14 text-right">Fils</span>
					<span className="hidden w-24 text-right md:inline">Dernier échange</span>
					<span className="w-4" />
				</div>
				<ul role="list" className="space-y-px">
					{shown.map((c) => (
						<li key={c.companyId} className="group flex items-center gap-4 rounded-k px-3 py-2 text-[13.5px] transition-colors hover:bg-k-hover">
							<Link href={`${base}/${c.companyId}`} className="min-w-0 flex-1">
								<span className="block truncate font-medium text-k-ink">{c.name}</span>
								{c.ebpCustomerId && <span className="block truncate text-[12px] text-k-ink-3">{c.ebpCustomerId}</span>}
							</Link>
							<span className="w-14 shrink-0 text-right tabular-nums text-k-ink-2">{c.threadCount}</span>
							<span className="hidden w-24 shrink-0 text-right text-[12.5px] text-k-ink-3 md:inline">
								{c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleDateString("fr-FR") : ""}
							</span>
							<a href={c.crmUrl} target="_blank" rel="noreferrer" title="Ouvrir la fiche CRM" aria-label="Ouvrir la fiche CRM" className="w-4 shrink-0 text-k-ink-3 hover:text-k-accent">
								<ExternalLink className="h-4 w-4" />
							</a>
						</li>
					))}
					{shown.length === 0 && <li className="px-3 py-3 text-[13px] text-k-ink-3">Aucun client ne correspond.</li>}
				</ul>
			</div>
		);
	}

	if (clients.length === 0) {
		return (
			<div className="text-sm text-muted-foreground">
				No client yet: threads are linked to CRM companies as messages arrive, and the backlog is processed in the background.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<input
				type="text"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				placeholder="Filter by name"
				className="w-full max-w-sm rounded border bg-transparent px-3 py-1.5 text-sm outline-none focus:border-brand"
			/>
			<div className="rounded-xl border bg-background/50">
				<ul role="list" className="divide-y">
					{shown.map((c) => (
						<li key={c.companyId} className="flex items-center gap-3 px-4 py-2 text-sm">
							<Link href={`${base}/${c.companyId}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
								{c.name}
							</Link>
							{c.ebpCustomerId && <span className="hidden sm:inline text-xs text-muted-foreground">{c.ebpCustomerId}</span>}
							<span className="w-16 shrink-0 text-right text-muted-foreground">{c.threadCount}</span>
							<span className="hidden md:inline w-28 shrink-0 text-right text-muted-foreground">
								{c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleDateString() : ""}
							</span>
							<a href={c.crmUrl} target="_blank" rel="noreferrer" title="Open in CRM" className="opacity-60 hover:opacity-100">
								<ExternalLink className="h-4 w-4" />
							</a>
						</li>
					))}
					{shown.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No client matches.</li>}
				</ul>
			</div>
		</div>
	);
}
