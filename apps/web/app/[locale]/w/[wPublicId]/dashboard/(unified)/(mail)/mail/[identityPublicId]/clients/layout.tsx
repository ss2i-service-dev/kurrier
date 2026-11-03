import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import KSectionLayout from "@/components/k/section-layout";
import React, { ReactNode } from "react";
import MailboxSearchHeader from "@/components/mailbox/mailbox-search-header";

// ss2i clients : dossiers virtuels par client de la CRM (identites pro).
type LayoutProps = {
	children: ReactNode;
	params: Promise<Record<string, string>>;
};

async function ClassicClientsLayout({ children, params }: LayoutProps) {
	return (
		<>
			<MailboxSearchHeader params={params} />
			{children}
		</>
	);
}

// ss2i : nouvelle interface (option par utilisateur) : cadre dedie (panneau + recherche).
export default async function ClientsLayout(props: any) {
	const page = <ClassicClientsLayout {...props} />;
	if (!(await isNouvelleInterface())) return page;
	return <KSectionLayout params={props.params}>{props.children}</KSectionLayout>;
}
