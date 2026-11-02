import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { fetchIdentityMailboxList, fetchMailbox } from "@/lib/actions/mailbox";
import { fetchLabels, fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { fetchClient, fetchClientThreads } from "@/lib/actions/thread-clients";
import { getPublicEnv } from "@schema";
import { PAGE_SIZE } from "@common/mail-client";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import { MailboxEntity } from "@db";

// ss2i clients : dossier virtuel d'un client : ses fils dans tous les dossiers de
// l'identite (hors corbeille et spam), memes composants de liste qu'un dossier, chaque
// fil ouvert et manipule dans son propre dossier.
export default async function ClientThreadsPage({
	params,
	searchParams,
}: {
	params: Promise<{ identityPublicId: string; clientId: string }>;
	searchParams: Promise<{ page?: string }>;
}) {
	const { identityPublicId, clientId } = await params;
	const { page } = await searchParams;
	const companyId = Number(clientId);
	const pageNumber = Number(page) > 0 ? Number(page) : 1;
	const workspacePublicId = await getWorkspacePublicId();

	const client = await fetchClient(identityPublicId, companyId);
	if (!client) {
		return <div className="p-4 text-sm text-muted-foreground">Unknown client.</div>;
	}

	const [publicConfig, identityMailboxes, globalLabels, { threads, total }] = await Promise.all([
		getPublicEnv(),
		fetchIdentityMailboxList(),
		fetchLabels(),
		fetchClientThreads(identityPublicId, companyId, pageNumber),
	]);
	const labelsByThreadId = threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};

	const identityEntry = identityMailboxes.find((e) => e.identity.publicId === identityPublicId);
	const mailboxById: Record<string, MailboxEntity> = {};
	for (const m of identityEntry?.mailboxes ?? []) mailboxById[m.id] = m as MailboxEntity;
	const { activeMailbox } = await fetchMailbox(identityPublicId, threads[0]?.mailboxSlug || "inbox");

	const base = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/clients/${companyId}`;
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between gap-3">
				<h1 className="min-w-0 truncate text-lg font-semibold">
					{client.name}
					{client.ebpCustomerId && <span className="ml-2 text-sm font-normal text-muted-foreground">{client.ebpCustomerId}</span>}
				</h1>
				<div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
					<span>Threads: {total}</span>
					<a href={client.crmUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
						CRM <ExternalLink className="h-3.5 w-3.5" />
					</a>
				</div>
			</header>

			{threads.length === 0 ? (
				<div className="text-sm text-muted-foreground">No threads for this client.</div>
			) : (
				<WebmailListLabelSearch
					mailboxThreads={threads}
					publicConfig={publicConfig}
					workspacePublicId={workspacePublicId}
					activeMailbox={activeMailbox}
					mailboxById={mailboxById}
					identityPublicId={identityPublicId}
					identityMailboxes={identityMailboxes}
					globalLabels={globalLabels}
					labelsByThreadId={labelsByThreadId}
				/>
			)}

			{pages > 1 && (
				<nav className="flex items-center justify-center gap-4 text-sm">
					{pageNumber > 1 ? (
						<Link href={pageNumber === 2 ? base : `${base}?page=${pageNumber - 1}`} className="hover:underline">
							Previous
						</Link>
					) : (
						<span className="opacity-40">Previous</span>
					)}
					<span className="text-muted-foreground">
						{pageNumber} / {pages}
					</span>
					{pageNumber < pages ? (
						<Link href={`${base}?page=${pageNumber + 1}`} className="hover:underline">
							Next
						</Link>
					) : (
						<span className="opacity-40">Next</span>
					)}
				</nav>
			)}
		</div>
	);
}
