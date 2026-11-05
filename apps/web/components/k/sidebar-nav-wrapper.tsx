import {
	fetchIdentityMailboxList,
	fetchIdentitySnoozedThreads,
	fetchMailboxUnreadCounts,
	fetchScheduledDraftCounts,
} from "@/lib/actions/mailbox";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { fetchDraftCounts } from "@/lib/actions/drafts";
import { fetchLabelsWithCounts } from "@/lib/actions/labels";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { LabelScope } from "@schema";
import KSidebarNav from "@/components/k/sidebar-nav";
import KLabelsSidebar from "@/components/k/labels-sidebar";

// Same data as identity-mailboxes-list-wrapper.tsx (with the draft count in place
// of the unread count for Drafts), rendered by the modern interface's sidebar.
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
				workspacePublicId={workspacePublicId}
			/>
			<DynamicContextProvider initialState={{ labels: [], scope: "thread" as LabelScope, workspacePublicId }}>
				<KLabelsSidebar globalLabels={globalLabels} />
			</DynamicContextProvider>
		</>
	);
}
