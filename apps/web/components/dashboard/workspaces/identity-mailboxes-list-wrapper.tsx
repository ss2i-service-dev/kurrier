import {
    fetchIdentityMailboxList,
    fetchIdentitySnoozedThreads,
    fetchMailboxUnreadCounts,
    fetchScheduledDraftCounts
} from "@/lib/actions/mailbox";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import {fetchDraftCounts} from "@/lib/actions/drafts";
import {collapsedIdentities} from "@/lib/actions/collapsed-identities";
import {fetchLabelsWithCounts} from "@/lib/actions/labels";
import {fetchIdentityClients} from "@/lib/actions/thread-clients";
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
        collapsed,
    ] = await Promise.all([
        fetchIdentityMailboxList(),
        fetchMailboxUnreadCounts(),
        fetchLabelsWithCounts(),
        getWorkspacePublicId(),
        fetchDraftCounts(),
        collapsedIdentities(),
    ]);

    // ss2i : le dossier Drafts affiche son nombre de brouillons a la place des non-lus.
    const unreadCounts = new Map(unreadThreadCounts);
    for (const [mailboxId, n] of draftCounts) {
        unreadCounts.set(mailboxId, { unreadThreads: n, unreadTotal: n });
    }

    const scheduledDraftsPromise = fetchScheduledDraftCounts();
    const snoozedThreadsPromise = fetchIdentitySnoozedThreads()
    // ss2i : clients (CRM) des identites pro ; vide (section absente) pour les autres.
    const clientsPromise = fetchIdentityClients()

    return (
        <>
            <IdentityMailboxesList
                identityMailboxes={identityMailboxes}
                unreadCounts={unreadCounts}
                scheduledDraftsPromise={scheduledDraftsPromise}
                snoozedThreadsPromise={snoozedThreadsPromise}
                clientsPromise={clientsPromise}
                workspacePublicId={workspacePublicId}
                initialCollapsed={collapsed}
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
