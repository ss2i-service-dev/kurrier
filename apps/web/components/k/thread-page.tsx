import React, { Suspense } from "react";
import {
	fetchIdentityMailboxList,
	fetchMailbox,
	fetchThreadMailSubscriptions,
	fetchWebMailThreadDetail,
} from "@/lib/actions/mailbox";
import { fetchThreadMailbox } from "@/lib/thread-mailbox";
import { threadOrder } from "@/lib/actions/thread-order";
import { kPinnedMap } from "@/lib/actions/k-pins";
import KThreadItem from "@/components/k/thread-item";
import { MessageEntity } from "@db";
import { getPublicEnv } from "@schema";
import ThreadToolbar from "@/components/k/thread-toolbar";
import { ThreadProvider } from "@/components/k/thread-context";
import ThreadMessages from "@/components/k/thread-messages";
import ReplyDock from "@/components/k/reply-dock";
import MailUnsubscriber from "@/components/mailbox/default/mail-unsubscriber";

// Reading pane. Action bar, subject, flat messages (older ones collapsed and
// grouped), reply anchored at the bottom.
export default async function KThreadPage({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	const { threadId, identityPublicId, mailboxSlug } = await params;
	const [activeThread, identityMailboxes, sent, order0, pins] = await Promise.all([
		fetchWebMailThreadDetail(threadId),
		fetchIdentityMailboxList(),
		fetchMailbox(identityPublicId, "sent").catch(() => null),
		threadOrder(),
		kPinnedMap(),
	]);
	const messages: MessageEntity[] = activeThread?.messages ?? [];
	// Actual folder of the thread (it may not be the folder in the URL).
	const { activeMailbox, mailboxSync } = await fetchThreadMailbox(identityPublicId, mailboxSlug, messages);
	const { byMessageId } = await fetchThreadMailSubscriptions({
		ownerId: activeMailbox.ownerId,
		messages: messages.map((m) => ({ id: m.id, headersJson: m.headersJson, from: m.from })),
	});

	if (!messages.length) {
		return (
			<div className="flex flex-1 items-center justify-center text-[13px] text-k-ink-3">
				This thread no longer exists or has been moved.
			</div>
		);
	}

	const first = messages[0];
	const last = messages[messages.length - 1];
	// Expanded by default: the last message and the unread ones.
	const expanded = messages.map((m, i) => i === messages.length - 1 || !m.seen);
	// Thread order chosen by the user (thread-order.ts): newest on top or at the
	// bottom. threadIndex stays the chronological index.
	const newestFirst = order0 === "newest_first";
	const order = messages.map((_, i) => i);
	if (newestFirst) order.reverse();
	const participants = new Set(
		messages.flatMap((m: any) => [m.from, m.to, m.cc].flatMap((v) => (v?.value ?? []).map((a: any) => a.address))),
	).size;
	const publicConfig = getPublicEnv();

	return (
		<ThreadProvider
			threadId={threadId}
			activeMailboxId={activeMailbox.id}
			activeMailboxKind={String(activeMailbox.kind)}
			markSmtp={!!mailboxSync}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<ThreadToolbar
					threadId={threadId}
					activeMailboxId={activeMailbox.id}
					activeMailboxKind={String(activeMailbox.kind)}
					markSmtp={!!mailboxSync}
					hasUnread={messages.some((m) => !m.seen)}
					pinned={!!pins[threadId]}
				/>
				<div className="k-scroll min-h-0 flex-1 overflow-y-auto" data-k-thread-scroll>
					<div className="w-full px-5 pb-10 pt-6 md:px-8">
						<div className="mb-4">
							<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
								<h1 className="min-w-0 flex-1 basis-[320px] text-[21px] font-semibold leading-snug tracking-[-0.015em] text-k-ink">
									{first.subject || "(no subject)"}
								</h1>
							</div>
							<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-k-ink-3">
								<span>
									{messages.length} message{messages.length > 1 ? "s" : ""}
								</span>
								<span aria-hidden>·</span>
								<span>
									{participants} participant{participants > 1 ? "s" : ""}
								</span>
								<MailUnsubscriber mailSubscription={byMessageId.get(first.id) ?? null} message={first} />
							</div>
						</div>

						<ThreadMessages expanded={order.map((i) => expanded[i])}>
							{order.map((threadIndex) => messages[threadIndex]).map((message) => {
								const threadIndex = messages.indexOf(message);
								return (
								<Suspense
									key={message.id}
									fallback={<div className="my-3 h-14 animate-pulse rounded-k bg-k-surface-2" />}
								>
									<KThreadItem
										message={message}
										threadIndex={threadIndex}
										numberOfMessages={messages.length}
										threadId={threadId}
										activeMailboxId={activeMailbox.id}
										markSmtp={!!mailboxSync}
										identityPublicId={identityPublicId}
										mailSubscription={byMessageId.get(message.id) ?? null}
										defaultExpanded={expanded[threadIndex]}
										identityMailboxes={identityMailboxes}
									/>
								</Suspense>
								);
							})}
						</ThreadMessages>
					</div>
				</div>
				{/* A draft at the end of the thread is already edited in place: no reply area. */}
				{!last.draft && <ReplyDock
					lastMessageId={last.id}
					publicConfig={publicConfig}
					identityMailboxes={identityMailboxes}
					sentMailboxId={sent?.activeMailbox?.id}
				/>}
			</div>
		</ThreadProvider>
	);
}

