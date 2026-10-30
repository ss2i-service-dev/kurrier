import React, { ReactNode } from "react";
import MailboxSearchHeader from "@/components/mailbox/mailbox-search-header";
import ThreadSlot from "@/components/mailbox/default/thread-slot";
import { unreadPanelEnabled } from "@/lib/actions/unread-panel";

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
