import { isModernUi } from "@/lib/actions/interface-pref";
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

// Modern interface (per-user option): dedicated frame (panel + search).
export default async function DashboardLayout(props: any) {
	const page = <ClassicDashboardLayout {...props} />;
	if (!(await isModernUi())) return page;
	return <KSectionLayout params={props.params}>{props.children}</KSectionLayout>;
}
