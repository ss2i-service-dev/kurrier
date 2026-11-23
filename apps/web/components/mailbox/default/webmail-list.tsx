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
import { useSendListRefresh } from "@/components/mailbox/default/draft-send-status";
import { inOutbox } from "@/lib/outbox-view";

type WebListProps = {
	mailboxThreadPromise: Promise<{ mailboxThreads: FetchMailboxThreadsResult, labelsByThreadId: FetchMailboxThreadLabelsResult }>;
	publicConfig: PublicConfig;
	identityPublicId: string;
	identityMailboxesPromise: Promise<FetchIdentityMailboxListResult>;
	fetchMailboxPromise: Promise<FetchMailboxResult>;
	globalLabelsPromise: Promise<FetchLabelsResult>;
	workspacePublicId?: string;
	// Ids of the sends visible in the Outbox (fetchOutboxIds), folder page only.
	outboxIdsPromise?: Promise<string[]>;
};

export default function WebmailList({
	mailboxThreadPromise,
	identityPublicId,
	publicConfig,
	identityMailboxesPromise,
	globalLabelsPromise,
	workspacePublicId,
	fetchMailboxPromise,
	outboxIdsPromise,
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
	const shownThreads = serverThreads.filter(
		(t) => !isHidden(String(t.mailboxId), String(t.threadId)),
	);

	// In Drafts, drafts whose send is waiting or in progress are left out: they are in the
	// Outbox. A failed send removes its mark (pipeline markFailed): the draft comes back to
	// Drafts with the error, and stays in the Outbox too.
	const outboxIds = new Set(outboxIdsPromise ? use(outboxIdsPromise) : []);
	const mailboxThreads =
		activeMailbox.kind === "drafts" ? shownThreads.filter((t) => !inOutbox(t.draftSend, outboxIds)) : shownThreads;

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

	// While a draft of the list is being sent, the list keeps refreshing (including the ones the
	// Outbox takes out of the list, to see them come back if the send fails).
	useSendListRefresh(shownThreads.map((t) => t.draftSend));

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
							{mailboxThreads.map(renderItem)}
						</ul>
					</div>
				)}
			</DynamicContextProvider>
		</div>
	);
}
