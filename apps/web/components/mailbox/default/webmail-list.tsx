"use client";
import * as React from "react";
import { MailboxEntity, MailboxSyncEntity } from "@db";
import { PublicConfig } from "@schema";
import {
	FetchIdentityMailboxListResult, FetchMailboxResult,
	FetchMailboxThreadsResult,
} from "@/lib/actions/mailbox";
import {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import MailListHeader from "@/components/mailbox/default/mail-list-header";
import WebmailListItem from "@/components/mailbox/default/webmail-list-item";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { useMediaQuery } from "@mantine/hooks";
import WebmailListItemMobile from "@/components/mailbox/default/webmail-list-item-mobile";
import { usePathname } from "next/navigation";
import {use} from "react";
import { useHiddenThreads } from "@/lib/pending-moves";
import { anySendTracked, isSendingDraft, useSendRefresh } from "@/components/mailbox/default/draft-send-status";
import { IconSend } from "@tabler/icons-react";

type WebListProps = {
	mailboxThreadPromise: Promise<{ mailboxThreads: FetchMailboxThreadsResult, labelsByThreadId: FetchMailboxThreadLabelsResult }>;
	publicConfig: PublicConfig;
	identityPublicId: string;
	identityMailboxesPromise: Promise<FetchIdentityMailboxListResult>;
	fetchMailboxPromise: Promise<FetchMailboxResult>;
	globalLabelsPromise: Promise<FetchLabelsResult>;
	workspacePublicId?: string;
};

export default function WebmailList({
	mailboxThreadPromise,
	identityPublicId,
	publicConfig,
	identityMailboxesPromise,
	globalLabelsPromise,
	workspacePublicId,
	fetchMailboxPromise
}: WebListProps) {
	const {labelsByThreadId, mailboxThreads: serverThreads} = use(mailboxThreadPromise)
	const globalLabels = use(globalLabelsPromise)
	const {mailboxSync, activeMailbox, count} = use(fetchMailboxPromise)
	const identityMailboxes = use(identityMailboxesPromise)
	const isMobile = useMediaQuery("(max-width: 768px)");
	// Actual URL path: useParams keeps the old threadId after returning to the
	// list from an open thread (preserved parallel route).
	const pathname = usePathname();
	const onThread = /\/threads\/[^/]+/.test(pathname ?? "");
	// Threads being moved away (trash, archive...) disappear from the list on click.
	const isHidden = useHiddenThreads();
	const mailboxThreads = serverThreads.filter(
		(t) => !isHidden(String(t.mailboxId), String(t.threadId)),
	);

	// In Drafts, pending sends (Undo still possible) form an Outbox at the top,
	// separate from the drafts: they must not be mistaken for drafts.
	const isDraftsBox = activeMailbox.kind === "drafts";
	const sending = isDraftsBox ? mailboxThreads.filter((t) => isSendingDraft(t.draftSend)) : [];
	const drafts = isDraftsBox ? mailboxThreads.filter((t) => !isSendingDraft(t.draftSend)) : mailboxThreads;

	const renderItem = (mailboxThreadItem: (typeof mailboxThreads)[number]) =>
								isMobile ? (
									<WebmailListItemMobile
										key={
											mailboxThreadItem.threadId + mailboxThreadItem.mailboxId
										}
										mailboxThreadItem={mailboxThreadItem}
										activeMailbox={activeMailbox}
										identityPublicId={identityPublicId}
										mailboxSync={mailboxSync ?? undefined}
										labelsByThreadId={labelsByThreadId}
									/>
								) : (
									<WebmailListItem
										key={
											mailboxThreadItem.threadId + mailboxThreadItem.mailboxId
										}
										mailboxThreadItem={mailboxThreadItem}
										workspacePublicId={workspacePublicId}
										orderedThreadIds={mailboxThreads.map((t) => String(t.threadId))}
										activeMailbox={activeMailbox}
										identityPublicId={identityPublicId}
										mailboxSync={mailboxSync ?? undefined}
										globalLabels={globalLabels}
										labelsByThreadId={labelsByThreadId}
									/>
								);

	// While a draft of the list is being sent, the list keeps refreshing.
	useSendRefresh(anySendTracked(mailboxThreads.map((t) => t.draftSend)));

	return (
		<div className={onThread ? "hidden" : ""} data-k-mail-list="">
			<DynamicContextProvider
				initialState={{
					selectedThreadIds: new Set(),
					activeMailbox,
					identityPublicId,
				}}
			>
				{mailboxThreads.length === 0 ? (
					<div className="p-4 text-center text-base text-muted-foreground">
						No messages in{" "}
						<span className={"lowercase"}>{activeMailbox.name}</span>
					</div>
				) : (
					<div className="rounded-xl border bg-background/50 z-[50]">
						<MailListHeader
							mailboxThreads={mailboxThreads}
							mailboxSync={mailboxSync ?? undefined}
							publicConfig={publicConfig}
							identityMailboxes={identityMailboxes}
							activeMailbox={activeMailbox}
							// "Select all" also offers the threads of the other pages; count
							// counts the folder's messages, hence "there may be more".
							selectAllScope={{ kind: "mailbox", mailboxId: String(activeMailbox.id) }}
							mayHaveMore={count > mailboxThreads.length}
						/>

						<ul role="list" className={`divide-y rounded-4xl`}>
							{sending.length > 0 ? (
								<>
									<li className="flex items-center gap-2 bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900 dark:bg-sky-900/50 dark:text-sky-100">
										<IconSend size={14} aria-hidden />
										Outbox ({sending.length}) — being sent, Undo still possible. These are not drafts anymore.
									</li>
									{sending.map(renderItem)}
									<li className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
										Drafts ({drafts.length})
									</li>
									{drafts.map(renderItem)}
								</>
							) : (
								mailboxThreads.map(renderItem)
							)}
						</ul>
					</div>
				)}
			</DynamicContextProvider>
		</div>
	);
}
