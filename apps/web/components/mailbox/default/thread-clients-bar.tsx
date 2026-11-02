import React from "react";
import Link from "next/link";
import { Building2, ExternalLink } from "lucide-react";
import { Container } from "@/components/common/containers";
import { fetchThreadClients } from "@/lib/actions/thread-clients";
import DetachClientButton from "@/components/mailbox/default/detach-client-button";

// ss2i clients : au-dessus d'un fil rattache a un ou plusieurs clients de la CRM, une
// pastille par client (vers son dossier virtuel), un lien vers la fiche CRM et un
// bouton de detachement (rattachement par domaine errone). Rien pour une identite non
// pro ni pour un fil sans client.
export default async function ThreadClientsBar({
	threadId,
	identityPublicId,
	workspacePublicId,
}: {
	threadId: string;
	identityPublicId: string;
	workspacePublicId: string;
}) {
	const clients = await fetchThreadClients(threadId, identityPublicId);
	if (!clients.length) return null;
	return (
		<Container variant="full" className="!px-2 lg:!px-4">
			<div className="flex flex-wrap items-center gap-2 px-3 pt-3 text-sm">
				{clients.map((c) => (
					<span
						key={c.companyId}
						className="inline-flex items-center gap-1 rounded-full border bg-brand-200/40 px-2 py-0.5 dark:bg-neutral-800"
						title={c.matchedBy === "domain" ? "Linked by email domain" : "Linked by contact email"}
					>
						<Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
						<Link
							href={`/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/clients/${c.companyId}`}
							className="font-medium hover:underline"
						>
							{c.name}
						</Link>
						<a
							href={c.crmUrl}
							target="_blank"
							rel="noreferrer"
							title="Open in CRM"
							className="opacity-60 hover:opacity-100"
						>
							<ExternalLink className="h-3.5 w-3.5" />
						</a>
						<DetachClientButton threadId={threadId} identityPublicId={identityPublicId} companyId={c.companyId} name={c.name} />
					</span>
				))}
			</div>
		</Container>
	);
}
