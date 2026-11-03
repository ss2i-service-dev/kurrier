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
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { KSectionHeader, KEmptyState, KPager } from "@/components/k/section";
import { Building2 } from "lucide-react";

// ss2i clients : dossier virtuel d'un client : ses fils dans tous les dossiers de
// l'identite (hors corbeille et spam), memes composants de liste qu'un dossier, chaque
// fil ouvert et manipule dans son propre dossier.
async function ClassicClientThreadsPage({
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
					keepArchived
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

// ss2i : nouvelle interface (option par utilisateur), memes donnees, autre presentation.
async function NouvelleClientThreadsPage({
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
		return <KEmptyState icon={<Building2 size={22} strokeWidth={1.6} />} title="Client introuvable" text="Ce client n'existe pas ou n'est pas rattaché à cette boîte." />;
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

	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title={client.name}
				subtitle={`${client.ebpCustomerId ? `${client.ebpCustomerId} · ` : ""}${total} fil${total > 1 ? "s" : ""}`}
				actions={
					<a
						href={client.crmUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-k-sm px-2.5 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
					>
						Fiche CRM <ExternalLink className="h-3.5 w-3.5" />
					</a>
				}
			/>
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
				// un fil archive reste visible dans son dossier client (patch 0081)
				keepArchived
				kTitle="Fils du client"
				kEmptyTitle="Aucun fil pour ce client"
				kEmptyText="Les fils sont rattachés aux clients du CRM au fil de l'arrivée des messages."
			/>
			<KPager page={pageNumber} total={total} pageSize={PAGE_SIZE} href={(n) => (n <= 1 ? base : `${base}?page=${n}`)} />
		</div>
	);
}

export default async function ClientThreadsPage(props: {
	params: Promise<{ identityPublicId: string; clientId: string }>;
	searchParams: Promise<{ page?: string }>;
}) {
	return (await isNouvelleInterface()) ? <NouvelleClientThreadsPage {...props} /> : <ClassicClientThreadsPage {...props} />;
}
