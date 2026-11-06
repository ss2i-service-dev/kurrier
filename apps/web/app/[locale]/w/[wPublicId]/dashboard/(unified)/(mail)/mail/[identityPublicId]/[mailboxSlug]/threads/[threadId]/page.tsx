import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import MailboxPage from "../../page";
import { fetchThreadMailbox } from "@/lib/thread-mailbox";
import React from "react";
import {fetchThreadMailSubscriptions, fetchWebMailThreadDetail} from "@/lib/actions/mailbox";
import ThreadItem from "@/components/mailbox/default/thread-item";
import { Divider } from "@mantine/core";
import {MessageEntity} from "@db";
import ThreadClientsBar from "@/components/mailbox/default/thread-clients-bar";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import { threadOrder } from "@/lib/actions/thread-order";
import { dedupeThreadMessages } from "@/lib/thread-dedupe";

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
			{shown.map((message, position) => {
				const threadIndex = newestFirst ? shown.length - 1 - position : position;
				return (
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
				);
			})}
		</>
	);
}

// ss2i : nouvelle interface : sur un chargement direct de l'URL d'un fil, la
// colonne liste garde la liste du dossier ; le fil est rendu dans @thread
// (@thread/threads/[threadId]/page.tsx), comme en navigation douce.
async function Page(props: { params: Promise<{ identityPublicId: string; mailboxSlug: string; threadId: string }> } & { searchParams: Promise<{ page?: string }> }) {
	if (await isNouvelleInterface()) return <MailboxPage {...(props as any)} />;
	return <ClassicPage {...props} />;
}

export default Page;
