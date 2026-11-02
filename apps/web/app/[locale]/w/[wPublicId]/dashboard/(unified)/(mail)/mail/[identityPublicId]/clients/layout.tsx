import React, { ReactNode } from "react";
import MailboxSearchHeader from "@/components/mailbox/mailbox-search-header";

// ss2i clients : dossiers virtuels par client de la CRM (identites pro).
type LayoutProps = {
	children: ReactNode;
	params: Promise<Record<string, string>>;
};

export default async function ClientsLayout({ children, params }: LayoutProps) {
	return (
		<>
			<MailboxSearchHeader params={params} />
			{children}
		</>
	);
}
