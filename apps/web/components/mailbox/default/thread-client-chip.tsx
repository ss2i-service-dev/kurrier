"use client";

import React from "react";
import Link from "next/link";
import { Building2, ExternalLink } from "lucide-react";
import DetachClientButton from "@/components/mailbox/default/detach-client-button";
import { useK, useNouvelle } from "@/components/k/ui-context";

// ss2i clients : pastille d'un client au-dessus d'un fil (partie cliente de
// thread-clients-bar, composant serveur : les textes dependent de l'interface).
export default function ThreadClientChip({
	threadId,
	identityPublicId,
	workspacePublicId,
	companyId,
	name,
	crmUrl,
	matchedBy,
}: {
	threadId: string;
	identityPublicId: string;
	workspacePublicId: string;
	companyId: number;
	name: string;
	crmUrl: string;
	matchedBy: string | null;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	return (
		<span
			className={
				nouvelle
					? "inline-flex items-center gap-1 rounded-full border border-k-line bg-k-accent-soft px-2 py-0.5 text-k-accent-soft-ink"
					: "inline-flex items-center gap-1 rounded-full border bg-brand-200/40 px-2 py-0.5 dark:bg-neutral-800"
			}
			title={
				matchedBy === "manual"
					? k("Linked by hand", "Rattaché à la main")
					: matchedBy === "domain"
						? k("Linked by email domain", "Rattaché par le domaine de l'adresse")
						: k("Linked by contact email", "Rattaché par l'adresse du contact")
			}
		>
			<Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
			<Link
				href={`/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/clients/${companyId}`}
				className="font-medium hover:underline"
			>
				{name}
			</Link>
			<a
				href={crmUrl}
				target="_blank"
				rel="noreferrer"
				title={k("Open in CRM", "Ouvrir dans le CRM")}
				aria-label={k("Open in CRM", "Ouvrir dans le CRM")}
				className="opacity-60 hover:opacity-100"
			>
				<ExternalLink className="h-3.5 w-3.5" />
			</a>
			<DetachClientButton threadId={threadId} identityPublicId={identityPublicId} companyId={companyId} name={name} />
		</span>
	);
}
