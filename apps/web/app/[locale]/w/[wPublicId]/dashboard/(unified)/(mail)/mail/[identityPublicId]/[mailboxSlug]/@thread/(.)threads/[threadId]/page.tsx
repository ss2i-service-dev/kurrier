import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import KThreadPage from "@/components/k/thread-page";
import { fetchThreadMailbox } from "@/lib/thread-mailbox";
import React, {Suspense} from "react";
import {fetchThreadMailSubscriptions, fetchWebMailThreadDetail} from "@/lib/actions/mailbox";
import ThreadItem from "@/components/mailbox/default/thread-item";
import ThreadAttachments from "@/components/mailbox/default/thread-attachments";
import { Divider } from "@mantine/core";
import {MessageEntity} from "@db";
import ThreadClientsBar from "@/components/mailbox/default/thread-clients-bar";
import {getWorkspacePublicId} from "@/lib/actions/clients";
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

	// ss2i clients : pastille du ou des clients CRM du fil (identites pro).
	const workspacePublicId = await getWorkspacePublicId();

	// ss2i : ordre du fil au choix de l'utilisateur (thread-order.ts). Les
	// messages arrivent du plus ancien au plus recent ; threadIndex garde
	// l'index chronologique (Reply sous le plus recent), l'objet va au-dessus
	// du premier message affiche.
	// ss2i : un mail present dans deux dossiers (Sent et Inbox) ne s'affiche qu'une fois (thread-dedupe.ts).
	const chronological = dedupeThreadMessages(activeThread?.messages ?? []);
	const newestFirst = (await threadOrder()) === "newest_first";
	const shown = newestFirst ? [...chronological].reverse() : chronological;

	return (
		<>
			{activeThread?.messages.length ? (
				<ThreadClientsBar threadId={threadId} identityPublicId={identityPublicId} workspacePublicId={workspacePublicId} />
			) : null}
			<Suspense fallback={null}>
				<ThreadAttachments messages={chronological} className="mx-4 mt-3 lg:mx-7" />
			</Suspense>
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

// ss2i : nouvelle interface (option par utilisateur) : panneau de lecture components/k.
async function Page(props: { params: Promise<{ identityPublicId: string; mailboxSlug: string; threadId: string }> }) {
	return (await isNouvelleInterface()) ? <KThreadPage {...props} /> : <ClassicPage {...props} />;
}

export default Page;
