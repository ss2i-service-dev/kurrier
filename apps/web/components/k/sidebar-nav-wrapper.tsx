import {
	fetchIdentityMailboxList,
	fetchIdentitySnoozedThreads,
	fetchMailboxUnreadCounts,
	fetchScheduledDraftCounts,
} from "@/lib/actions/mailbox";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { fetchDraftCounts } from "@/lib/actions/drafts";
import { fetchLabelsWithCounts } from "@/lib/actions/labels";
import { fetchIdentityClients } from "@/lib/actions/thread-clients";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { LabelScope } from "@schema";
import KSidebarNav from "@/components/k/sidebar-nav";
import KLabelsSidebar from "@/components/k/labels-sidebar";

// SS2i (nouvelle interface) : memes donnees que identity-mailboxes-list-wrapper.tsx
// (dont le compteur de brouillons a la place des non-lus pour Drafts, et la
// section Clients), rendues par la barre laterale de la nouvelle interface.
export default async function KSidebarNavWrapper() {
	const [identityMailboxes, unreadThreadCounts, globalLabels, workspacePublicId, draftCounts] = await Promise.all([
		fetchIdentityMailboxList(),
		fetchMailboxUnreadCounts(),
		fetchLabelsWithCounts(),
		getWorkspacePublicId(),
		fetchDraftCounts(),
	]);
	const unreadCounts = new Map(unreadThreadCounts);
	for (const [mailboxId, n] of draftCounts) {
		unreadCounts.set(mailboxId, { unreadThreads: n, unreadTotal: n });
	}
	return (
		<>
			<KSidebarNav
				identityMailboxes={identityMailboxes}
				unreadCounts={unreadCounts}
				scheduledDraftsPromise={fetchScheduledDraftCounts()}
				snoozedThreadsPromise={fetchIdentitySnoozedThreads()}
				clientsPromise={fetchIdentityClients()}
				workspacePublicId={workspacePublicId}
			/>
			<DynamicContextProvider initialState={{ labels: [], scope: "thread" as LabelScope, workspacePublicId }}>
				<KLabelsSidebar globalLabels={globalLabels} />
			</DynamicContextProvider>
		</>
	);
}
