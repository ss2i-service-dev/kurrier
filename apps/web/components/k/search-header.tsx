import React from "react";
import MailboxSearch from "@/components/mailbox/default/mailbox-search";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import MobileNavButton from "@/components/k/mobile-nav-button";

// SS2i (nouvelle interface) : en-tete de la colonne liste, la recherche seule
// (le compte et les parametres sont dans la barre laterale).
export default async function KSearchHeader({ params }: { params: Promise<Record<string, string>> }) {
	const { identityPublicId, mailboxSlug } = await params;
	const workspacePublicId = await getWorkspacePublicId();
	return (
		<header className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
			<MobileNavButton />
			<MailboxSearch publicId={identityPublicId} mailboxSlug={mailboxSlug} workspacePublicId={workspacePublicId} nouvelle />
		</header>
	);
}
