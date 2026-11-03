import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import KSectionLayout from "@/components/k/section-layout";
import React, { ReactNode } from "react";
import MailboxSearchHeader from "@/components/mailbox/mailbox-search-header";

type LayoutProps = {
    children: ReactNode;
    params: Promise<Record<string, string>>;
};

async function ClassicDashboardLayout({ children, params }: LayoutProps) {

    return <>
        <MailboxSearchHeader params={params} />
        {children}
    </>
}

// ss2i : nouvelle interface (option par utilisateur) : cadre dedie (panneau + recherche).
export default async function DashboardLayout(props: any) {
	const page = <ClassicDashboardLayout {...props} />;
	if (!(await isNouvelleInterface())) return page;
	return <KSectionLayout params={props.params}>{props.children}</KSectionLayout>;
}
