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
import {ComposeStyleProvider} from "@/components/mailbox/default/compose-style-context";
import DraftBackupRecovery from "@/components/mailbox/default/draft-backup-recovery";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { isSignedIn } from "@/lib/actions/auth";
import { fetchWorkspaces } from "@/lib/actions/workspace";
import KMailShell from "@/components/k/mail-shell";
import KCompose from "@/components/k/compose";
import KSidebarNavWrapper from "@/components/k/sidebar-nav-wrapper";

export default async function DashboardLayout({
	children
}: {
	children: React.ReactNode;
}) {
	const publicConfig = getPublicEnv();
	const workspacePublicId = await getWorkspacePublicId()
	const identityMailboxes = await fetchIdentityMailboxList();
	// ss2i : contenu des lignes de liste (objet seul ou objet et extrait).
	const previewMode = await listPreviewMode();
	// ss2i : style RFC a l'envoi (apercu de la citation dans l'editeur de reponse).
	const rfcStyle = await rfcStyleEnabled();

	// ss2i : nouvelle interface (option par utilisateur, Parametres > General > Interface).
	if (await isNouvelleInterface()) {
		const [user, userWorkspaces] = await Promise.all([isSignedIn(), fetchWorkspaces()]);
		return (
			<ComposeStyleProvider rfcStyle={rfcStyle}>
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
					{/* ss2i : recuperation des brouillons non recus par le serveur (patch 0077) */}
					<DraftBackupRecovery />
				</ListPreviewProvider>
			</ComposeStyleProvider>
		);
	}

	return (
		<ComposeStyleProvider rfcStyle={rfcStyle}>
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
