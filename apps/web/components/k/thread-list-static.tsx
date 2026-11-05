"use client";
// Thread list already loaded on the server (snoozed, search, label). Same
// selection header and same rows as a folder list (KListHeader, KThreadRow),
// including the All / Unread filter.
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
	/** Virtual folder: each thread keeps its own folder. */
	mailboxById?: Record<string, MailboxEntity>;
	selectAllScope?: SelectAllScope;
	totalThreads?: number;
	/** Header title (defaults to the active folder name). */
	kTitle?: React.ReactNode;
	kEmptyTitle?: string;
	kEmptyText?: string;
	/** View that also shows archived threads: archiving does not remove them from it. */
	keepArchived?: boolean;
};

export default function KThreadListStatic(props: KStaticListProps) {
	const { mailboxThreads: serverThreads, activeMailbox, identityPublicId, identityMailboxes } = props;
	const isHidden = useHiddenThreads({ keepArchived: props.keepArchived });
	const threads = serverThreads.filter(
		(t) =>
			!isHidden(String(t.mailboxId), String(t.threadId)),
	);
	const ownAddresses = React.useMemo(
		() => new Set(identityMailboxes.map((im) => String(im.identity.value).toLowerCase())),
		[identityMailboxes],
	);
	React.useEffect(() => {
		settle(serverThreads.map((t) => ({ threadId: String(t.threadId), unreadCount: t.unreadCount, starred: t.starred })));
	}, [serverThreads]);
	// After a search started from an open thread, the slot keeps the old thread:
	// the list is hidden only when the URL really is that of a thread.
	const pathname = usePathname();
	const onThread = /\/threads\/[^/]+/.test(pathname ?? "");

	if (threads.length === 0) {
		return (
			<KEmptyState
				icon={<Inbox size={22} strokeWidth={1.6} />}
				title={props.kEmptyTitle ?? "Nothing here"}
				text={props.kEmptyText ?? `No messages in "${activeMailbox.name}".`}
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
		return <KEmptyState icon={<Inbox size={22} strokeWidth={1.6} />} title="All caught up" text="No unread messages in this list." />;
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
