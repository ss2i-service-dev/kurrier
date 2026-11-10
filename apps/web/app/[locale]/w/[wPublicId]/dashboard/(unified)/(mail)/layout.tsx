import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import { getPublicEnv } from "@schema";
import * as React from "react";
import ComposeMail from "@/components/mailbox/default/compose-mail";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import {Suspense} from "react";
import Loading from "@/app/loading";
import IdentityMailboxesListWrapper from "@/components/dashboard/workspaces/identity-mailboxes-list-wrapper";
import NavUserWrapper from "@/components/ui/dashboards/workspace/nav-user-wrapper";
import {fetchIdentityMailboxList} from "@/lib/actions/mailbox";
import {listPreviewMode} from "@/lib/actions/list-preview";
import {ListPreviewProvider} from "@/components/mailbox/default/list-preview-context";
import {rfcStyleEnabled} from "@/lib/actions/rfc-style";
import {stripSubjectPrefixesEnabled} from "@/lib/actions/subject-prefixes";
import {ComposeStyleProvider} from "@/components/mailbox/default/compose-style-context";
import DraftBackupRecovery from "@/components/mailbox/default/draft-backup-recovery";
import { isModernUi } from "@/lib/actions/interface-pref";
import { isSignedIn } from "@/lib/actions/auth";
import { fetchWorkspaces } from "@/lib/actions/workspace";
import KMailShell from "@/components/k/mail-shell";
import KCompose from "@/components/k/compose";
import KSidebarNavWrapper from "@/components/k/sidebar-nav-wrapper";
import { tabMetadata } from "@/lib/tab-identity";

// Title and icon of the tab specific to the section.
export const metadata = tabMetadata("mail");

export default async function DashboardLayout({
	children
}: {
	children: React.ReactNode;
}) {
	const publicConfig = getPublicEnv();
	const workspacePublicId = await getWorkspacePublicId()
	const identityMailboxes = await fetchIdentityMailboxList();
	// Content of the list rows (subject only, or subject and snippet).
	const previewMode = await listPreviewMode();
	// RFC style on send (preview of the quote in the reply editor).
	const rfcStyle = await rfcStyleEnabled();
	// Subject without Re:/Fwd: (editor, lists and threads).
	const stripPrefixes = await stripSubjectPrefixesEnabled();

	// Modern interface (per-user option, Settings > General > Interface).
	if (await isModernUi()) {
		const [user, userWorkspaces] = await Promise.all([isSignedIn(), fetchWorkspaces()]);
		return (
			<ComposeStyleProvider rfcStyle={rfcStyle} stripSubjectPrefixes={stripPrefixes}>
				<ListPreviewProvider mode={previewMode}>
					<KMailShell
						workspacePublicId={workspacePublicId}
						userEmail={user?.email ?? null}
						identities={identityMailboxes.map(({ identity }) => ({
							publicId: identity.publicId,
							value: identity.value,
							displayName: identity.displayName,
						}))}
						workspaces={userWorkspaces.map(({ workspaces }) => ({
							publicId: workspaces.publicId,
							id: workspaces.id,
							name: workspaces.name,
						}))}
						compose={
							<Suspense fallback={<div className="h-10 rounded-k bg-k-hover" />}>
								<KCompose publicConfig={publicConfig} identityMailboxes={identityMailboxes} />
							</Suspense>
						}
						nav={
							<Suspense fallback={null}>
								<KSidebarNavWrapper />
							</Suspense>
						}
					>
						{children}
					</KMailShell>
					{/* Recovery of drafts the server did not receive */}
					<DraftBackupRecovery />
				</ListPreviewProvider>
			</ComposeStyleProvider>
		);
	}

	return (
		<ComposeStyleProvider rfcStyle={rfcStyle} stripSubjectPrefixes={stripPrefixes}>
			<DraftBackupRecovery />
			<AppSidebar
				workspacePublicId={workspacePublicId}
				sidebarTopContent={
					<Suspense fallback={<Loading />}>
						<div className={"-mt-1"} key={"mail-sidebar-compose"}>
							<ComposeMail publicConfig={publicConfig} identityMailboxes={identityMailboxes} />
						</div>
					</Suspense>
				}
				navUserContent={<Suspense fallback={<Loading />}><NavUserWrapper /></Suspense>}
				sidebarSectionContent={
					<Suspense fallback={<Loading />}>
						<IdentityMailboxesListWrapper />
					</Suspense>
				}
			/>
			<SidebarInset><ListPreviewProvider mode={previewMode}>{children}</ListPreviewProvider></SidebarInset>
		</ComposeStyleProvider>
	);
}
