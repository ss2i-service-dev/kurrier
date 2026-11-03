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
import { anySendTracked, useSendRefresh } from "@/components/mailbox/default/draft-send-status";

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
	// Chemin reel de l'URL : useParams garde l'ancien threadId apres un retour
	// a la liste depuis un fil ouvert (route parallele conservee).
	const pathname = usePathname();
	const onThread = /\/threads\/[^/]+/.test(pathname ?? "");
	// ss2i : les fils en cours de depart (corbeille, archive...) disparaissent des le clic.
	const isHidden = useHiddenThreads();
	const mailboxThreads = serverThreads.filter(
		(t) => !isHidden(String(t.mailboxId), String(t.threadId)),
	);

	// ss2i : tant qu'un brouillon de la liste est en cours d'envoi, la liste est actualisee.
	useSendRefresh(anySendTracked(mailboxThreads.map((t) => t.draftSend)));

	return (
		<div className={onThread ? "hidden" : ""}>
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
							// ss2i : « Select all » propose aussi les fils des autres pages ; count
							// compte les messages du dossier, d'ou « il y en a peut-etre d'autres ».
							selectAllScope={{ kind: "mailbox", mailboxId: String(activeMailbox.id) }}
							mayHaveMore={count > mailboxThreads.length}
						/>

						<ul role="list" className={`divide-y rounded-4xl`}>
							{mailboxThreads.map((mailboxThreadItem) =>
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
								),
							)}
						</ul>
					</div>
				)}
			</DynamicContextProvider>
		</div>
	);
}
