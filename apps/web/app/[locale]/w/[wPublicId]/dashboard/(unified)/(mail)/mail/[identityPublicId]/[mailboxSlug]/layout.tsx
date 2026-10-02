import React, { ReactNode } from "react";
import MailboxSearchHeader from "@/components/mailbox/mailbox-search-header";
import ThreadSlot from "@/components/mailbox/default/thread-slot";

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



	return (
		<>
            <MailboxSearchHeader params={params} />

			<ThreadSlot>{thread}</ThreadSlot>
			{children}
		</>
	);
}
