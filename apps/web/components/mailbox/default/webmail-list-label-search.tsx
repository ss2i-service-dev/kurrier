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
import { useModernUi } from "@/components/k/ui-context";
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
    // Virtual folder: each thread keeps its own mailbox for opening and actions;
    // activeMailbox then only serves the header and the context.
    mailboxById?: Record<string, MailboxEntity>;
    // "Select all" beyond the page (search only for now).
    selectAllScope?: SelectAllScope;
    totalThreads?: number;
    // View that also shows archived threads: archiving does not remove them from it.
    keepArchived?: boolean;
};

// Modern interface (per-user option): same data, rendered by the modern list.
// The classic list (below) is unchanged.
export default function WebmailListLabelSearch(props: WebListProps & Pick<KStaticListProps, "kTitle" | "kEmptyTitle" | "kEmptyText">) {
    const modern = useModernUi();
    return modern ? <KThreadListStatic {...(props as KStaticListProps)} /> : <ClassicWebmailListLabelSearch {...props} />;
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
                                    }: WebListProps) {
    const mailboxOf = (mailboxId: string) => mailboxById?.[mailboxId] ?? activeMailbox;
    // Like webmail-list, threads being moved away (trash, archive...) disappear
    // from the list on click.
    const isHidden = useHiddenThreads({ keepArchived });
    const mailboxThreads = serverThreads.filter(
        (t) =>
            !isHidden(String(t.mailboxId), String(t.threadId)),
    );
    const isMobile = useMediaQuery("(max-width: 768px)");
    // Actual URL path, not useParams: after a search started from an open thread,
    // the preserved @thread slot keeps the old threadId and the results list stayed hidden.
    const pathname = usePathname();
    const onThread = /\/threads\/[^/]+/.test(pathname ?? "");

    // Displayed order of the threads, for range selection (Shift+click).
    // Test: apps/web/test/thread-selection.ts.
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
