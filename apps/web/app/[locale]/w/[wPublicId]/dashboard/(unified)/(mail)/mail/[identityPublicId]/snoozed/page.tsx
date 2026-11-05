import {
	fetchMailbox,
	fetchIdentityMailboxList,
	fetchIdentitySnoozedThreads,
} from "@/lib/actions/mailbox";
import { fetchLabels, fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { getPublicEnv } from "@schema";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import { isModernUi } from "@/lib/actions/interface-pref";
import { KSectionHeader } from "@/components/k/section";

async function ClassicSnoozedPage({
	params,
}: {
	params: { identityPublicId: string };
}) {
	const { identityPublicId } = await params;
	const publicConfig = await getPublicEnv();
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabels();

	const { threads } = await fetchIdentitySnoozedThreads();
	const labelsByThreadId =
		threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};

	const firstMailboxSlug = threads[0]?.mailboxSlug || "inbox";
	const { activeMailbox } = await fetchMailbox(
		identityPublicId,
		firstMailboxSlug,
	);

	const filteredThreads = threads.filter(
		(thread) => thread.identityPublicId === identityPublicId,
	);

	const workspacePublicId = await getWorkspacePublicId()

	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Snoozed</h1>
				<div className="text-sm text-muted-foreground">
					Threads: {threads.length}
				</div>
			</header>

			{filteredThreads.length === 0 ? (
				<div className="text-sm text-muted-foreground">No snoozed threads.</div>
			) : (
				<WebmailListLabelSearch
					mailboxThreads={filteredThreads}
					publicConfig={publicConfig}
					workspacePublicId={workspacePublicId}
					activeMailbox={activeMailbox}
					identityPublicId={identityPublicId}
					identityMailboxes={identityMailboxes}
					globalLabels={globalLabels}
					labelsByThreadId={labelsByThreadId}
				/>
			)}
		</div>
	);
}

// Modern interface (per-user option): same data, different presentation.
async function ModernSnoozedPage({ params }: { params: { identityPublicId: string } }) {
	const { identityPublicId } = await params;
	const publicConfig = await getPublicEnv();
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabels();

	const { threads } = await fetchIdentitySnoozedThreads();
	const filteredThreads = threads.filter((thread) => thread.identityPublicId === identityPublicId);
	const labelsByThreadId = filteredThreads.length > 0 ? await fetchMailboxThreadLabels(filteredThreads) : {};
	const { activeMailbox } = await fetchMailbox(identityPublicId, threads[0]?.mailboxSlug || "inbox");
	const workspacePublicId = await getWorkspacePublicId();
	const n = filteredThreads.length;

	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title="Snoozed"
				subtitle={n === 0 ? "No snoozed threads" : `${n} snoozed thread${n > 1 ? "s" : ""}, back in the inbox when due`}
			/>
			<WebmailListLabelSearch
				mailboxThreads={filteredThreads}
				publicConfig={publicConfig}
				workspacePublicId={workspacePublicId}
				activeMailbox={activeMailbox}
				identityPublicId={identityPublicId}
				identityMailboxes={identityMailboxes}
				globalLabels={globalLabels}
				labelsByThreadId={labelsByThreadId}
				kTitle="Snoozed threads"
				kEmptyTitle="No snoozed threads"
				kEmptyText="Snooze a message from the list or the reader: it will come back to the top of the inbox at the chosen time."
			/>
		</div>
	);
}

export default async function SnoozedPage(props: { params: { identityPublicId: string } }) {
	return (await isModernUi()) ? <ModernSnoozedPage {...props} /> : <ClassicSnoozedPage {...props} />;
}
