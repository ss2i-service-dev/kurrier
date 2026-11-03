import React, { ReactNode } from "react";
import MailboxSearchHeader from "@/components/mailbox/mailbox-search-header";
import ThreadSlot from "@/components/mailbox/default/thread-slot";
import { unreadPanelEnabled } from "@/lib/actions/unread-panel";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import MailPanes from "@/components/k/mail-panes";
import KSearchHeader from "@/components/k/search-header";

type LayoutProps = {
	children: ReactNode;
	thread: ReactNode;
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
	}>;
};

export default async function DashboardLayout({
	children,
	thread,
	params,
}: LayoutProps) {
	// ss2i : nouvelle interface (option par utilisateur) : liste et lecture cote a cote.
	if (await isNouvelleInterface()) {
		return <MailPanes list={<><KSearchHeader params={params} />{children}</>} reader={thread} />;
	}
	// ss2i : panneau des non-lus a cote du fil ouvert, option par utilisateur.
	const { identityPublicId, mailboxSlug } = await params;
	const unreadPanel = (await unreadPanelEnabled()) ? { identityPublicId, mailboxSlug } : null;

	return (
		<>
            <MailboxSearchHeader params={params} />

			<ThreadSlot unreadPanel={unreadPanel}>{thread}</ThreadSlot>
			{children}
		</>
	);
}
