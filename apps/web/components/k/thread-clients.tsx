import React from "react";
import { fetchThreadClients } from "@/lib/actions/thread-clients";
import ThreadClientChip from "@/components/mailbox/default/thread-client-chip";

// SS2i (Outlook) : societes (CRM) rattachees au fil, a droite de l'objet. Memes
// donnees et memes pastilles que thread-clients-bar.tsx (interface Gmail), sans
// le bandeau au-dessus du fil.
export default async function KThreadClients({
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
		<div className="flex flex-wrap items-center justify-end gap-1.5 pt-0.5 text-sm">
			{clients.map((c) => (
				<ThreadClientChip
					key={c.companyId}
					threadId={threadId}
					identityPublicId={identityPublicId}
					workspacePublicId={workspacePublicId}
					companyId={c.companyId}
					name={c.name}
					crmUrl={c.crmUrl}
					matchedBy={c.matchedBy}
				/>
			))}
		</div>
	);
}
