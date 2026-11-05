import React from "react";
import MailboxSearch from "@/components/mailbox/default/mailbox-search";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import MobileNavButton from "@/components/k/mobile-nav-button";

// Header of the list column: search only (the account and settings are in the
// sidebar).
export default async function KSearchHeader({ params }: { params: Promise<Record<string, string>> }) {
	const { identityPublicId, mailboxSlug } = await params;
	const workspacePublicId = await getWorkspacePublicId();
	return (
		<header className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
			<MobileNavButton />
			<MailboxSearch publicId={identityPublicId} mailboxSlug={mailboxSlug} workspacePublicId={workspacePublicId} modern />
		</header>
	);
}
