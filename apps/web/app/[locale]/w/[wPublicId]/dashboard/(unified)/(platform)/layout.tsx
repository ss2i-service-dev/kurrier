import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import KAppShell from "@/components/k/app-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import {Suspense} from "react";
import Loading from "@/app/loading";
import NavUserWrapper from "@/components/ui/dashboards/workspace/nav-user-wrapper";
import * as React from "react";
import NavMainWrapper from "@/components/nav-main-wrapper";
import KPlatformNavWrapper from "@/components/k/platform/nav-wrapper";

async function ClassicDashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const workspacePublicId = await getWorkspacePublicId()

	return (
		<>
			<AppSidebar
				workspacePublicId={workspacePublicId}
				sidebarSectionContent={
					<Suspense fallback={<Loading />}>
						<NavMainWrapper />
					</Suspense>}
				navUserContent={<Suspense fallback={<Loading />}><NavUserWrapper /></Suspense>}
			/>
			<SidebarInset>{children}</SidebarInset>
		</>
	);
}

// ss2i : nouvelle interface (option par utilisateur) : coque de la nouvelle
// interface avec sa propre navigation de section, meme contenu.
export default async function DashboardLayout(props: { children: React.ReactNode }) {
	if (!(await isNouvelleInterface())) return <ClassicDashboardLayout {...props} />;
	return (
		<KAppShell action={undefined} nav={<Suspense fallback={null}>
					<KPlatformNavWrapper />
				</Suspense>}>
			{props.children}
		</KAppShell>
	);
}
