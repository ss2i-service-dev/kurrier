"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { ClientRow } from "@/lib/actions/thread-clients";

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
