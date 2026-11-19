import {
	fetchMailbox,
	fetchIdentityMailboxList,
	fetchIdentityExpiringThreads,
} from "@/lib/actions/mailbox";
import { fetchLabels, fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { getPublicEnv } from "@schema";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
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

	const { threads } = await fetchIdentityExpiringThreads();
	const labelsByThreadId =
		threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};

	const firstMailboxSlug = threads[0]?.mailboxSlug || "archive";
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
				<h1 className="text-lg font-semibold">Expiring soon</h1>
				<div className="text-sm text-muted-foreground">
					Threads: {threads.length}
				</div>
			</header>

			{filteredThreads.length === 0 ? (
				<div className="text-sm text-muted-foreground">No expiring threads.</div>
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

// ss2i : nouvelle interface (option par utilisateur), memes donnees, autre presentation.
async function NouvelleExpiringPage({ params }: { params: { identityPublicId: string } }) {
	const { identityPublicId } = await params;
	const publicConfig = await getPublicEnv();
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabels();

	const { threads } = await fetchIdentityExpiringThreads();
	const filteredThreads = threads.filter((thread) => thread.identityPublicId === identityPublicId);
	const labelsByThreadId = filteredThreads.length > 0 ? await fetchMailboxThreadLabels(filteredThreads) : {};
	const { activeMailbox } = await fetchMailbox(identityPublicId, threads[0]?.mailboxSlug || "archive");
	const workspacePublicId = await getWorkspacePublicId();
	const n = filteredThreads.length;

	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title="Expire bientôt"
				subtitle={n === 0 ? "Aucun fil n'expire" : `${n} fil${n > 1 ? "s" : ""} archivé${n > 1 ? "s" : ""} avec une durée de vie, les plus proches d'abord : à la date, ${n > 1 ? "ils vont" : "il va"} à la Corbeille`}
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
				kTitle="Fils qui vont disparaître"
				kEmptyTitle="Aucun fil n'expire"
				kEmptyText="Archivez un message avec « Archiver pour… » (à côté d'Archiver) : il apparaît ici jusqu'à sa date de disparition."
			/>
		</div>
	);
}

export default async function ExpiringPage(props: { params: { identityPublicId: string } }) {
	return (await isNouvelleInterface()) ? <NouvelleExpiringPage {...props} /> : <ClassicExpiringPage {...props} />;
}
