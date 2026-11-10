import { isModernUi } from "@/lib/actions/interface-pref";
import KThreadPage from "@/components/k/thread-page";
import { fetchThreadMailbox } from "@/lib/thread-mailbox";
import React, {Suspense} from "react";
import {fetchThreadMailSubscriptions, fetchWebMailThreadDetail} from "@/lib/actions/mailbox";
import ThreadItem from "@/components/mailbox/default/thread-item";
import { Divider } from "@mantine/core";
import {MessageEntity} from "@db";
import { threadOrder } from "@/lib/actions/thread-order";
import { dedupeThreadMessages } from "@/lib/thread-dedupe";
import Loading from "@/app/loading";

async function ClassicPage({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	const { threadId, identityPublicId, mailboxSlug } = await params;
	const activeThread = await fetchWebMailThreadDetail(threadId);
	const { activeMailbox, mailboxSync } = await fetchThreadMailbox(
		identityPublicId,
		mailboxSlug,
		activeThread?.messages ?? [],
	);

    const { byMessageId } = await fetchThreadMailSubscriptions({
        ownerId: activeMailbox.ownerId,
        messages:
            activeThread?.messages.map((m: MessageEntity) => ({
                id: m.id,
                headersJson: m.headersJson,
                from: m.from,
            })) ?? [],
    });

	// Thread order chosen by the user (thread-order.ts). Messages arrive from
	// oldest to newest; threadIndex keeps the chronological index (Reply goes
	// under the newest), the subject goes above the first message shown.
	// A mail present in two folders (Sent and Inbox) is shown once (thread-dedupe.ts).
	const chronological = dedupeThreadMessages(activeThread?.messages ?? []);
	const newestFirst = (await threadOrder()) === "newest_first";
	const shown = newestFirst ? [...chronological].reverse() : chronological;

	return (
		<>
			{shown.map((message, position) => {
				const threadIndex = newestFirst ? shown.length - 1 - position : position;
				return (
					<Suspense fallback={<Loading />}>
						<div key={message.id}>
							<ThreadItem
								message={message}
								threadIndex={threadIndex}
								numberOfMessages={shown.length}
							showSubject={position === 0}
								threadId={threadId}
								activeMailboxId={activeMailbox.id}
								markSmtp={!!mailboxSync}
								identityPublicId={identityPublicId}
								mailSubscription={byMessageId.get(message.id) ?? null}
							/>
							<Divider className={"opacity-50 mb-6"} ml={"xl"} mr={"xl"} />
						</div>
					</Suspense>
				);
			})}
		</>
	);
}

// Modern interface (per-user option): reading pane in components/k.
async function Page(props: { params: Promise<{ identityPublicId: string; mailboxSlug: string; threadId: string }> }) {
	return (await isModernUi()) ? <KThreadPage {...props} /> : <ClassicPage {...props} />;
}

export default Page;
