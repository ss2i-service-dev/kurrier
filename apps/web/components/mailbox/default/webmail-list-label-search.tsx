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
import { useLinkedThreads } from "@/lib/client-link";
import type { SelectAllScope } from "@/lib/actions/select-all";
import { useNouvelle } from "@/components/k/ui-context";
import KThreadListStatic, { type KStaticListProps } from "@/components/k/thread-list-static";

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
    // ss2i : vue qui montre aussi les fils archives (dossier client) : archiver ne les en retire pas.
    keepArchived?: boolean;
    // ss2i (OI 10270) : dossier « Sans client » : un fil rattache a un client en sort aussitot.
    hideLinked?: boolean;
};

// ss2i : nouvelle interface (option par utilisateur) : memes donnees, liste de la nouvelle
// interface. La classique (ci-dessous) est inchangee.
export default function WebmailListLabelSearch(props: WebListProps & Pick<KStaticListProps, "kTitle" | "kEmptyTitle" | "kEmptyText">) {
    const nouvelle = useNouvelle();
    return nouvelle ? <KThreadListStatic {...(props as KStaticListProps)} /> : <ClassicWebmailListLabelSearch {...props} />;
}

function ClassicWebmailListLabelSearch({
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
                                        keepArchived,
                                        hideLinked,
                                    }: WebListProps) {
    const mailboxOf = (mailboxId: string) => mailboxById?.[mailboxId] ?? activeMailbox;
    // ss2i : comme webmail-list, les fils en cours de depart (corbeille, archive...)
    // disparaissent des le clic. Avant, ils restaient affiches jusqu'au rechargement.
    const isHidden = useHiddenThreads({ keepArchived });
    const isLinked = useLinkedThreads();
    const mailboxThreads = serverThreads.filter(
        (t) =>
            !isHidden(String(t.mailboxId), String(t.threadId)) &&
            !(hideLinked && isLinked(identityPublicId, String(t.threadId))),
    );
    const isMobile = useMediaQuery("(max-width: 768px)");
    // ss2i : chemin reel de l'URL, pas useParams : apres une recherche lancee depuis un fil ouvert,
    // le slot @thread conserve garde l'ancien threadId et la liste des resultats restait masquee.
    const pathname = usePathname();
    const onThread = /\/threads\/[^/]+/.test(pathname ?? "");

    // ss2i : ordre affiche des fils, pour la selection par plage (Maj+clic).
    // Test apps/web/test/thread-selection.ts (regression du 05/11/2026).
    const orderedThreadIds = mailboxThreads.map((t) => String(t.threadId));

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
                                        orderedThreadIds={orderedThreadIds}
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
