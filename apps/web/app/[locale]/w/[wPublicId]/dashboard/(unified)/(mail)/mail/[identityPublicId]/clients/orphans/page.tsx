import Link from "next/link";
import { fetchIdentityMailboxList, fetchMailbox } from "@/lib/actions/mailbox";
import { fetchLabels, fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { fetchOrphanThreads, isProIdentityPublicId } from "@/lib/actions/thread-clients";
import { getPublicEnv } from "@schema";
import { PAGE_SIZE } from "@common/mail-client";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import { MailboxEntity } from "@db";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { KSectionHeader, KEmptyState, KPager } from "@/components/k/section";
import { Building2 } from "lucide-react";

// ss2i clients (OI 10270) : dossier virtuel « Sans client » : fils de l'identite pro avec au
// moins un interlocuteur exterieur (hors domaines internes et automates) et aucun client, hors
// corbeille et spam, du plus recent au plus ancien. On les rattache en les glissant sur un
// client de la barre laterale (poignee) ou par « Rattacher a un client... » ; un fil rattache
// sort aussitot de la liste. Segment statique : il passe avant clients/[clientId].
type PageProps = {
	params: Promise<{ identityPublicId: string }>;
	searchParams: Promise<{ page?: string }>;
};

async function loadOrphans({ params, searchParams }: PageProps) {
	const { identityPublicId } = await params;
	const { page } = await searchParams;
	const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;
	const workspacePublicId = await getWorkspacePublicId();
	const pro = await isProIdentityPublicId(identityPublicId);
	if (!pro) return { pro, identityPublicId, workspacePublicId } as const;
	const [publicConfig, identityMailboxes, globalLabels, { threads, total }] = await Promise.all([
		getPublicEnv(),
		fetchIdentityMailboxList(),
		fetchLabels(),
		fetchOrphanThreads(identityPublicId, pageNumber),
	]);
	const labelsByThreadId = threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};
	const identityEntry = identityMailboxes.find((e) => e.identity.publicId === identityPublicId);
	const mailboxById: Record<string, MailboxEntity> = {};
	for (const m of identityEntry?.mailboxes ?? []) mailboxById[m.id] = m as MailboxEntity;
	const { activeMailbox } = await fetchMailbox(identityPublicId, threads[0]?.mailboxSlug || "inbox");
	const base = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/clients/orphans`;
	return {
		pro,
		identityPublicId,
		workspacePublicId,
		pageNumber,
		publicConfig,
		identityMailboxes,
		globalLabels,
		threads,
		total,
		labelsByThreadId,
		mailboxById,
		activeMailbox,
		base,
	} as const;
}

async function ClassicOrphansPage(props: PageProps) {
	const d = await loadOrphans(props);
	if (!d.pro) {
		return <div className="p-4 text-sm text-muted-foreground">Clients are only available on professional mailboxes.</div>;
	}
	const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between gap-3">
				<h1 className="min-w-0 truncate text-lg font-semibold">No client</h1>
				<div className="shrink-0 text-sm text-muted-foreground">Threads: {d.total}</div>
			</header>
			<p className="text-sm text-muted-foreground">
				Conversations with an outside contact and no client. Drag one (handle on the left of the row) onto a client of the sidebar, or select it and use Client.
			</p>
			{d.threads.length === 0 ? (
				<div className="text-sm text-muted-foreground">No conversation without a client.</div>
			) : (
				<WebmailListLabelSearch
					mailboxThreads={d.threads}
					publicConfig={d.publicConfig}
					workspacePublicId={d.workspacePublicId}
					activeMailbox={d.activeMailbox}
					mailboxById={d.mailboxById}
					identityPublicId={d.identityPublicId}
					identityMailboxes={d.identityMailboxes}
					globalLabels={d.globalLabels}
					labelsByThreadId={d.labelsByThreadId}
					keepArchived
					hideLinked
				/>
			)}
			{pages > 1 && (
				<nav className="flex items-center justify-center gap-4 text-sm">
					{d.pageNumber > 1 ? (
						<Link href={d.pageNumber === 2 ? d.base : `${d.base}?page=${d.pageNumber - 1}`} className="hover:underline">
							Previous
						</Link>
					) : (
						<span className="opacity-40">Previous</span>
					)}
					<span className="text-muted-foreground">
						{d.pageNumber} / {pages}
					</span>
					{d.pageNumber < pages ? (
						<Link href={`${d.base}?page=${d.pageNumber + 1}`} className="hover:underline">
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
async function NouvelleOrphansPage(props: PageProps) {
	const d = await loadOrphans(props);
	if (!d.pro) {
		return (
			<KEmptyState
				icon={<Building2 size={22} strokeWidth={1.6} />}
				title="Clients indisponibles"
				text="Les clients ne sont disponibles que sur les boîtes professionnelles."
			/>
		);
	}
	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title="Sans client"
				subtitle={`${d.total} fil${d.total > 1 ? "s" : ""} avec un interlocuteur extérieur et aucun client · glisser un fil (poignée à gauche) sur un client de la barre latérale pour le rattacher`}
			/>
			<WebmailListLabelSearch
				mailboxThreads={d.threads}
				publicConfig={d.publicConfig}
				workspacePublicId={d.workspacePublicId}
				activeMailbox={d.activeMailbox}
				mailboxById={d.mailboxById}
				identityPublicId={d.identityPublicId}
				identityMailboxes={d.identityMailboxes}
				globalLabels={d.globalLabels}
				labelsByThreadId={d.labelsByThreadId}
				keepArchived
				hideLinked
				kTitle="Fils sans client"
				kEmptyTitle="Aucun fil sans client"
				kEmptyText="Tous les fils avec un interlocuteur extérieur sont rattachés à un client."
			/>
			<KPager page={d.pageNumber} total={d.total} pageSize={PAGE_SIZE} href={(n) => (n <= 1 ? d.base : `${d.base}?page=${n}`)} />
		</div>
	);
}

export default async function OrphanThreadsPage(props: PageProps) {
	return (await isNouvelleInterface()) ? <NouvelleOrphansPage {...props} /> : <ClassicOrphansPage {...props} />;
}
