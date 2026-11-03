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

type WebListProps = {
    mailboxThreads: FetchMailboxThreadsResult;
    publicConfig: PublicConfig;
    activeMailbox: MailboxEntity;
    identityPublicId: string;
    identityMailboxes: FetchIdentityMailboxListResult;
    globalLabels: FetchLabelsResult;
    labelsByThreadId: FetchMailboxThreadLabelsResult;
    workspacePublicId?: string;
    mailboxSync?: MailboxSyncEntity;
    // ss2i : dossier virtuel (clients) : chaque fil garde son propre dossier pour l'ouverture
    // et les actions ; activeMailbox ne sert alors qu'a l'en-tete et au contexte.
    mailboxById?: Record<string, MailboxEntity>;
};

export default function WebmailListLabelSearch({
                                        mailboxThreads,
                                        identityPublicId,
                                        mailboxSync,
                                        activeMailbox,
                                        publicConfig,
                                        identityMailboxes,
                                        globalLabels,
                                        workspacePublicId,
                                        labelsByThreadId,
                                        mailboxById,
                                    }: WebListProps) {
    const mailboxOf = (mailboxId: string) => mailboxById?.[mailboxId] ?? activeMailbox;
    const isMobile = useMediaQuery("(max-width: 768px)");
    // ss2i : chemin reel de l'URL, pas useParams : apres une recherche lancee depuis un fil ouvert,
    // le slot @thread conserve garde l'ancien threadId et la liste des resultats restait masquee.
    const pathname = usePathname();
    const onThread = /\/threads\/[^/]+/.test(pathname ?? "");

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
                        />

                        <ul role="list" className={`divide-y rounded-4xl`}>
                            {mailboxThreads.map((mailboxThreadItem) =>
                                isMobile ? (
                                    <WebmailListItemMobile
                                        key={
                                            mailboxThreadItem.threadId + mailboxThreadItem.mailboxId
                                        }
                                        mailboxThreadItem={mailboxThreadItem}
                                        activeMailbox={mailboxOf(mailboxThreadItem.mailboxId)}
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
                                        activeMailbox={mailboxOf(mailboxThreadItem.mailboxId)}
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
