"use client";
// SS2i (nouvelle interface) : liste de fils deja chargee cote serveur (reportes,
// clients, recherche, libelle). Meme en-tete de selection et memes lignes que la
// liste d'un dossier (KListHeader, KThreadRow), filtre Tous / Non lus compris.
import * as React from "react";
import { usePathname } from "next/navigation";
import { Inbox } from "lucide-react";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import type { PublicConfig } from "@schema";
import type { FetchIdentityMailboxListResult, FetchMailboxThreadsResult } from "@/lib/actions/mailbox";
import type { FetchLabelsResult, FetchMailboxThreadLabelsResult } from "@/lib/actions/labels";
import type { SelectAllScope } from "@/lib/actions/select-all";
import { DynamicContextProvider, useDynamicContext } from "@/hooks/use-dynamic-context";
import { useHiddenThreads } from "@/lib/pending-moves";
import KListHeader from "@/components/k/list-header";
import KThreadRow from "@/components/k/thread-row";
import { KEmptyState } from "@/components/k/section";
import { settle, useMailStore } from "@/components/k/mail-store";

export type KStaticListProps = {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	activeMailbox: MailboxEntity;
	identityPublicId: string;
	identityMailboxes: FetchIdentityMailboxListResult;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	workspacePublicId?: string;
	mailboxSync?: MailboxSyncEntity;
	/** Dossier virtuel (clients) : chaque fil garde son dossier. */
	mailboxById?: Record<string, MailboxEntity>;
	selectAllScope?: SelectAllScope;
	totalThreads?: number;
	/** Titre de l'en-tete (par defaut le nom du dossier actif). */
	kTitle?: React.ReactNode;
	kEmptyTitle?: string;
	kEmptyText?: string;
	/** Vue qui montre aussi les fils archives (dossier client) : archiver ne les en retire pas (patch 0081). */
	keepArchived?: boolean;
};

export default function KThreadListStatic(props: KStaticListProps) {
	const { mailboxThreads: serverThreads, activeMailbox, identityPublicId, identityMailboxes } = props;
	const isHidden = useHiddenThreads({ keepArchived: props.keepArchived });
	const threads = serverThreads.filter((t) => !isHidden(String(t.mailboxId), String(t.threadId)));
	const ownAddresses = React.useMemo(
		() => new Set(identityMailboxes.map((im) => String(im.identity.value).toLowerCase())),
		[identityMailboxes],
	);
	React.useEffect(() => {
		settle(serverThreads.map((t) => ({ threadId: String(t.threadId), unreadCount: t.unreadCount, starred: t.starred })));
	}, [serverThreads]);
	// Apres une recherche lancee depuis un fil ouvert, le slot garde l'ancien fil : on masque la liste
	// seulement quand l'URL est bien celle d'un fil.
	const pathname = usePathname();
	const onThread = /\/threads\/[^/]+/.test(pathname ?? "");

	if (threads.length === 0) {
		return (
			<KEmptyState
				icon={<Inbox size={22} strokeWidth={1.6} />}
				title={props.kEmptyTitle ?? "Rien ici"}
				text={props.kEmptyText ?? `Aucun message dans « ${activeMailbox.name} ».`}
			/>
		);
	}

	return (
		<div className={onThread ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
			<DynamicContextProvider
				initialState={{ selectedThreadIds: new Set(), activeMailbox, identityPublicId, filter: "all" }}
			>
				<KListHeader
					mailboxThreads={threads}
					mailboxSync={props.mailboxSync}
					publicConfig={props.publicConfig}
					identityMailboxes={identityMailboxes}
					activeMailbox={activeMailbox}
					selectAllScope={props.selectAllScope}
					totalThreads={props.totalThreads}
					title={props.kTitle}
				/>
				<Rows {...props} threads={threads} ownAddresses={ownAddresses} />
			</DynamicContextProvider>
		</div>
	);
}

function Rows({
	threads,
	ownAddresses,
	activeMailbox,
	mailboxById,
	identityPublicId,
	mailboxSync,
	labelsByThreadId,
	globalLabels,
	workspacePublicId,
}: KStaticListProps & { threads: FetchMailboxThreadsResult; ownAddresses: Set<string> }) {
	const { state } = useDynamicContext<{ filter?: "all" | "unread" }>();
	const filter = state?.filter ?? "all";
	const readOverride = useMailStore((s) => s.read);
	const rows =
		filter === "unread"
			? threads.filter((t) => {
					const o = readOverride.get(String(t.threadId));
					return o === undefined ? t.unreadCount > 0 : !o;
				})
			: threads;
	const orderedThreadIds = rows.map((t) => String(t.threadId));

	if (rows.length === 0) {
		return <KEmptyState icon={<Inbox size={22} strokeWidth={1.6} />} title="Tout est lu" text="Aucun message non lu dans cette liste." />;
	}
	return (
		<ul role="list" className="space-y-px px-1.5 pb-2">
			{rows.map((item) => (
				<KThreadRow
					key={item.threadId + item.mailboxId}
					item={item}
					workspacePublicId={workspacePublicId}
					orderedThreadIds={orderedThreadIds}
					activeMailbox={mailboxById?.[item.mailboxId] ?? activeMailbox}
					identityPublicId={identityPublicId}
					mailboxSync={mailboxSync}
					globalLabels={globalLabels}
					labelsByThreadId={labelsByThreadId}
					ownAddresses={ownAddresses}
				/>
			))}
		</ul>
	);
}
