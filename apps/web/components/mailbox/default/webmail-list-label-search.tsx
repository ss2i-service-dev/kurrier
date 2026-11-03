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
import { useHiddenThreads } from "@/lib/pending-moves";
import type { SelectAllScope } from "@/lib/actions/select-all";

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
    // ss2i : « Select all » au-dela de la page (recherche seulement pour l'instant).
    selectAllScope?: SelectAllScope;
    totalThreads?: number;
};

export default function WebmailListLabelSearch({
                                        mailboxThreads: serverThreads,
                                        identityPublicId,
                                        mailboxSync,
                                        activeMailbox,
                                        publicConfig,
                                        identityMailboxes,
                                        globalLabels,
                                        workspacePublicId,
                                        labelsByThreadId,
                                        mailboxById,
                                        selectAllScope,
                                        totalThreads,
                                    }: WebListProps) {
    const mailboxOf = (mailboxId: string) => mailboxById?.[mailboxId] ?? activeMailbox;
    // ss2i : comme webmail-list, les fils en cours de depart (corbeille, archive...)
    // disparaissent des le clic. Avant, ils restaient affiches jusqu'au rechargement.
    const isHidden = useHiddenThreads();
    const mailboxThreads = serverThreads.filter(
        (t) => !isHidden(String(t.mailboxId), String(t.threadId)),
    );
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
                            selectAllScope={selectAllScope}
                            totalThreads={totalThreads}
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
