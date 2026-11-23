import {
	fetchMailbox,
	fetchIdentityMailboxList,
	fetchIdentityExpiringThreads,
} from "@/lib/actions/mailbox";
import { fetchLabels, fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { getPublicEnv } from "@schema";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import { isModernUi } from "@/lib/actions/interface-pref";
import { KSectionHeader } from "@/components/k/section";

async function ClassicExpiringPage({
	params,
}: {
	params: { identityPublicId: string };
}) {
	const { identityPublicId } = await params;
	const publicConfig = await getPublicEnv();
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabels();

	const { threads } = await fetchIdentityExpiringThreads(identityPublicId);
	const labelsByThreadId =
		threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};

	const firstMailboxSlug = threads[0]?.mailboxSlug || "archive";
	const { activeMailbox } = await fetchMailbox(
		identityPublicId,
		firstMailboxSlug,
	);

	const workspacePublicId = await getWorkspacePublicId()

	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Expiring soon</h1>
				<div className="text-sm text-muted-foreground">
					Threads: {threads.length}
				</div>
			</header>

			{threads.length === 0 ? (
				<div className="text-sm text-muted-foreground">No thread is expiring.</div>
			) : (
				<WebmailListLabelSearch
					mailboxThreads={threads}
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
async function ModernExpiringPage({ params }: { params: { identityPublicId: string } }) {
	const { identityPublicId } = await params;
	const publicConfig = await getPublicEnv();
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabels();

	const { threads } = await fetchIdentityExpiringThreads(identityPublicId);
	const labelsByThreadId = threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};
	const { activeMailbox } = await fetchMailbox(identityPublicId, threads[0]?.mailboxSlug || "archive");
	const workspacePublicId = await getWorkspacePublicId();
	const n = threads.length;

	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title="Expiring soon"
				subtitle={n === 0 ? "No thread is expiring" : `${n} thread${n > 1 ? "s" : ""} archived for a chosen duration, closest first: on that date, ${n > 1 ? "they go" : "it goes"} to Trash`}
			/>
			<WebmailListLabelSearch
				mailboxThreads={threads}
				publicConfig={publicConfig}
				workspacePublicId={workspacePublicId}
				activeMailbox={activeMailbox}
				identityPublicId={identityPublicId}
				identityMailboxes={identityMailboxes}
				globalLabels={globalLabels}
				labelsByThreadId={labelsByThreadId}
				kTitle="Threads about to disappear"
				kEmptyTitle="No thread is expiring"
				kEmptyText={'Archive a message with "Archive for..." (next to Archive): it shows up here until its expiry date.'}
			/>
		</div>
	);
}

export default async function ExpiringPage(props: { params: { identityPublicId: string } }) {
	return (await isModernUi()) ? <ModernExpiringPage {...props} /> : <ClassicExpiringPage {...props} />;
}
