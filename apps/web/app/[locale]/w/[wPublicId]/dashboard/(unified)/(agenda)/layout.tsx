// ss2i : page Agenda (agenda Outlook de l'utilisateur, facon Notion Calendar), dans les deux
// interfaces : barre laterale classique avec en-tete, ou coque de la nouvelle interface.
import * as React from "react";
import { Suspense } from "react";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import KAppShell from "@/components/k/app-shell";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import Loading from "@/app/loading";
import NavUserWrapper from "@/components/ui/dashboards/workspace/nav-user-wrapper";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { outlookCalendarBoxes } from "@/lib/actions/outlook-calendar";
import KAgendaNav, { KAgendaNew } from "@/components/outlook-calendar/agenda-nav";
import { tabMetadata } from "@/lib/tab-identity";

// ss2i : titre et icone de l'onglet propres a la section.
export const metadata = tabMetadata("agenda");

export default async function AgendaLayout({ children }: { children: React.ReactNode }) {
	const [nouvelle, boxes] = await Promise.all([isNouvelleInterface(), outlookCalendarBoxes()]);
	if (nouvelle) {
		return (
			<KAppShell action={<KAgendaNew nouvelle />} nav={<KAgendaNav boxes={boxes} nouvelle />}>
				{children}
			</KAppShell>
		);
	}
	const workspacePublicId = await getWorkspacePublicId();
	return (
		<>
			<AppSidebar
				workspacePublicId={workspacePublicId}
				sidebarTopContent={
					<div className="-mt-1">
						<KAgendaNew nouvelle={false} />
					</div>
				}
				sidebarSectionContent={
					<div className="px-2 py-2">
						<KAgendaNav boxes={boxes} nouvelle={false} />
					</div>
				}
				navUserContent={
					<Suspense fallback={<Loading />}>
						<NavUserWrapper />
					</Suspense>
				}
			/>
			<SidebarInset className="h-svh overflow-hidden">
				<header className="flex items-center gap-2 border-b bg-background/60 px-4 py-3 backdrop-blur">
					<SidebarTrigger className="-ml-1" />
					<Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
					<h1 className="text-sm font-semibold">Agenda</h1>
				</header>
				<div className="flex min-h-0 flex-1 flex-col">{children}</div>
			</SidebarInset>
		</>
	);
}
