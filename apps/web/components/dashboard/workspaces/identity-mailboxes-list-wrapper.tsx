import {
    fetchIdentityMailboxList,
    fetchIdentitySnoozedThreads,
    fetchMailboxUnreadCounts,
    fetchScheduledDraftCounts
} from "@/lib/actions/mailbox";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import {fetchDraftCounts} from "@/lib/actions/drafts";
import {fetchLabelsWithCounts} from "@/lib/actions/labels";
import IdentityMailboxesList from "@/components/dashboard/identity-mailboxes-list";
import {DynamicContextProvider} from "@/hooks/use-dynamic-context";
import {LabelScope} from "@schema";
import RenderLabelHomeSidebar from "@/components/dashboard/labels/render-label-home-sidebar";

async function IdentityMailboxesListWrapper() {


    const [
        identityMailboxes,
        unreadThreadCounts,
        globalLabels,
        workspacePublicId,
        draftCounts,
    ] = await Promise.all([
        fetchIdentityMailboxList(),
        fetchMailboxUnreadCounts(),
        fetchLabelsWithCounts(),
        getWorkspacePublicId(),
        fetchDraftCounts(),
    ]);

    // ss2i : le dossier Drafts affiche son nombre de brouillons a la place des non-lus.
    const unreadCounts = new Map(unreadThreadCounts);
    for (const [mailboxId, n] of draftCounts) {
        unreadCounts.set(mailboxId, { unreadThreads: n, unreadTotal: n });
    }

    const scheduledDraftsPromise = fetchScheduledDraftCounts();
    const snoozedThreadsPromise = fetchIdentitySnoozedThreads()

    return (
        <>
            <IdentityMailboxesList
                identityMailboxes={identityMailboxes}
                unreadCounts={unreadCounts}
                scheduledDraftsPromise={scheduledDraftsPromise}
                snoozedThreadsPromise={snoozedThreadsPromise}
                workspacePublicId={workspacePublicId}
            />

            <DynamicContextProvider
                initialState={{
                    labels: [],
                    scope: "thread" as LabelScope,
                    workspacePublicId,
                }}
            >
                <RenderLabelHomeSidebar globalLabels={globalLabels}/>
            </DynamicContextProvider>
        </>
    );


}

export default IdentityMailboxesListWrapper;
