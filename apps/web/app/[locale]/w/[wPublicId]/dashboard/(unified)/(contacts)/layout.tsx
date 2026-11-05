import { isModernUi } from "@/lib/actions/interface-pref";
import KAppShell from "@/components/k/app-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import { fetchContactLabelsWithCounts } from "@/lib/actions/labels";
import { LabelScope } from "@schema";
import ContactsNav from "@/components/dashboard/contacts/contacts-sidebar";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import * as React from "react";
import NewContactButton from "@/components/dashboard/contacts/new-contact-button";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import {Suspense} from "react";
import Loading from "@/app/loading";
import NavUserWrapper from "@/components/ui/dashboards/workspace/nav-user-wrapper";
import KNewContactButton from "@/components/k/new-contact-button";
import { loadKBooks } from "@/components/k/contacts-data";
import KContactsNav from "@/components/k/contacts-nav";
import RenderContactsLabelHomeSidebar from "@/components/dashboard/labels/render-contacts-label-home-sidebar";

async function ClassicDashboardLayout({
	children
}: {
	children: React.ReactNode;
}) {
	const [contactLabels, workspacePublicId] = await Promise.all([
		fetchContactLabelsWithCounts(),
		getWorkspacePublicId()
	]);

	return (
		<>
			<AppSidebar
				workspacePublicId={workspacePublicId}
				sidebarTopContent={
					<Suspense fallback={<Loading />}>
						<div className={"-mt-1"}>
							<NewContactButton hideOnMobile={true} workspacePublicId={workspacePublicId} />
						</div>
					</Suspense>
				}
				navUserContent={<Suspense fallback={<Loading />}><NavUserWrapper /></Suspense>}
				sidebarSectionContent={
					<>
						<ContactsNav workspacePublicId={workspacePublicId} />
						<DynamicContextProvider
							initialState={{
								labels: contactLabels,
								scope: "contact" as LabelScope,
								workspacePublicId
							}}
						>
							{/*<LabelHome />*/}
							<RenderContactsLabelHomeSidebar globalLabels={contactLabels} />
						</DynamicContextProvider>
					</>
				}
			/>
			<SidebarInset>{children}</SidebarInset>
		</>
	);
}

// Modern interface (per-user option): shell of the modern interface, same
// navigation and same content.
export default async function DashboardLayout(props: { children: React.ReactNode }) {
	if (!(await isModernUi())) return <ClassicDashboardLayout {...props} />;
	const [contactLabels, workspacePublicId] = await Promise.all([fetchContactLabelsWithCounts(), getWorkspacePublicId()]);
	const { books, total } = await loadKBooks();
	return (
		<KAppShell
			action={<KNewContactButton workspacePublicId={workspacePublicId} />}
			nav={
				<DynamicContextProvider initialState={{ labels: contactLabels, scope: "contact" as LabelScope, workspacePublicId }}>
					<Suspense fallback={null}>
						<KContactsNav
							workspacePublicId={workspacePublicId}
							books={books}
							total={total}
							globalLabels={contactLabels}
						/>
					</Suspense>
				</DynamicContextProvider>
			}
		>
			{props.children}
		</KAppShell>
	);
}
