import React from "react";
import {fetchMailbox, fetchThreadMailSubscriptions, fetchWebMailThreadDetail} from "@/lib/actions/mailbox";
import ThreadItem from "@/components/mailbox/default/thread-item";
import { Divider } from "@mantine/core";
import {MessageEntity} from "@db";
import ThreadClientsBar from "@/components/mailbox/default/thread-clients-bar";
import {getWorkspacePublicId} from "@/lib/actions/clients";

async function Page({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	const { threadId, identityPublicId, mailboxSlug } = await params;
	const { activeMailbox, mailboxSync } = await fetchMailbox(
		identityPublicId,
		mailboxSlug,
	);
	const activeThread = await fetchWebMailThreadDetail(threadId);

    const { byMessageId } = await fetchThreadMailSubscriptions({
        ownerId: activeMailbox.ownerId,
        messages:
            activeThread?.messages.map((m: MessageEntity) => ({
                id: m.id,
                headersJson: m.headersJson,
                from: m.from,
            })) ?? [],
    });

	// ss2i clients : pastille du ou des clients CRM du fil (identites pro).
	const workspacePublicId = await getWorkspacePublicId();

	return (
		<>
			{activeThread?.messages.length ? (
				<ThreadClientsBar threadId={threadId} identityPublicId={identityPublicId} workspacePublicId={workspacePublicId} />
			) : null}
			{activeThread?.messages.map((message, threadIndex) => {
				return (
					<div key={message.id}>
						<ThreadItem
							message={message}
							threadIndex={threadIndex}
							numberOfMessages={activeThread.messages.length}
							threadId={threadId}
							activeMailboxId={activeMailbox.id}
							markSmtp={!!mailboxSync}
                            identityPublicId={identityPublicId}
                            mailSubscription={byMessageId.get(message.id) ?? null}
						/>
						<Divider className={"opacity-50 mb-6"} ml={"xl"} mr={"xl"} />
					</div>
				);
			})}
		</>
	);
}

export default Page;
