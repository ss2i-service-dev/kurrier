import React from "react";
import { Container } from "@/components/common/containers";
import { fetchThreadClients, isProIdentityPublicId } from "@/lib/actions/thread-clients";
import ThreadClientChip from "@/components/mailbox/default/thread-client-chip";
import { LinkThreadToClientButton } from "@/components/mailbox/default/client-link-ui";
import { AddToAgendaButton } from "@/components/mailbox/default/add-to-agenda";

// ss2i clients : au-dessus d'un fil rattache a un ou plusieurs clients de la CRM, une
// pastille par client (vers son dossier virtuel), un lien vers la fiche CRM et un
// bouton de detachement (rattachement par domaine errone). Identite pro : « Rattacher a un
// client... » (OI 10270), meme pour un fil sans client, et « Ajouter a l'agenda » (OI 10280,
// boites M365 seulement). Rien pour une identite non pro.
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
	if (!clients.length && !(await isProIdentityPublicId(identityPublicId))) return null;
	return (
		<Container variant="full" className="!px-2 lg:!px-4">
			<div className="flex flex-wrap items-center gap-2 px-3 pt-3 text-sm">
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
				<LinkThreadToClientButton identityPublicId={identityPublicId} threadId={threadId} />
				<AddToAgendaButton identityPublicId={identityPublicId} threadId={threadId} />
			</div>
		</Container>
	);
}
