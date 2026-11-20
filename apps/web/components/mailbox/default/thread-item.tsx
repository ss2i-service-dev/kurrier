import React from "react";
import { cidUrlMap, inlineImageIdsShownInBody } from "@/lib/inline-images";
import { MessageEntity } from "@db";
import EmailViewer from "@/components/mailbox/default/email-viewer";
import EmailRenderer from "@/components/mailbox/default/email-renderer";
import { Avatar } from "@mantine/core";
import {
	fetchIdentityMailboxList,
	fetchMessageAttachments,
	FetchThreadMailSubsResult,
	getSignedUrlsForMessage
} from "@/lib/actions/mailbox";
import { getPublicEnv } from "@schema";
import { getMessageAddress, getMessageName, avatarName } from "@common/mail-client";
import { Container } from "@/components/common/containers";
import RenderInvite from "@/components/mailbox/default/render-invite";
import {fetchEventPreviewItems} from "@/lib/actions/calendar";
import { remoteImagesAllowedForContact } from "@/lib/actions/contact-images";
import { fetchDraftOriginal } from "@/lib/actions/drafts";
import DraftThreadItem from "@/components/mailbox/default/draft-thread-item";

export default async function ThreadItem({
	message,
	threadIndex,
	numberOfMessages,
	showSubject,
	threadId,
	activeMailboxId,
	markSmtp,
    identityPublicId,
    mailSubscription,
	starred,
}: {
	message: MessageEntity;
	threadIndex: number;
	numberOfMessages: number;
	// ss2i : objet du fil au-dessus du premier message affiche (ordre du fil
	// au choix de l'utilisateur, thread-order.ts). threadIndex reste l'index
	// chronologique : les boutons Reply suivent le message le plus recent.
	showSubject?: boolean;
	threadId: string;
	activeMailboxId: string;
	markSmtp: boolean;
    identityPublicId: string;
    mailSubscription: FetchThreadMailSubsResult["byMessageId"] | null;
	// ss2i : le fil est etoile (transmis a la barre du mail : « Archiver pour… »).
	starred?: boolean;
}) {
	const publicConfig = getPublicEnv();
	const identityMailboxes = await fetchIdentityMailboxList();

	// ss2i : un brouillon s'ouvre dans l'editeur, pas dans le lecteur.
	if (message.draft) {
		const original = await fetchDraftOriginal(
			(message.metaData as any)?.draft?.originalMessageId,
		);
		return (
			<DraftThreadItem
				draft={message}
				original={original}
				publicConfig={publicConfig}
				identityMailboxes={identityMailboxes}
			/>
		);
	}

	const attachments = await getSignedUrlsForMessage(message.id)
    const preview = await fetchEventPreviewItems(attachments, identityPublicId)
	// ss2i : images inline deja dans le corps -> pas repetees sous le mail ; cid: resolus.
	const inlineShownIds = Array.from(inlineImageIdsShownInBody(message.html, attachments));
	const cidUrls = cidUrlMap(attachments);
	const remoteImagesAllowed = await remoteImagesAllowedForContact(
		getMessageAddress(message, "from"),
	);

	return (
		<>
			<Container variant="full" className="!px-2 lg:!px-4">
				<div className={"flex gap-4 p-3"}>
					<div className={"hidden md:block shrink-0 pt-4"}>
						<Avatar
							size="lg"
							radius="xl"
							name={avatarName(
							getMessageName(message, "from") ||
								getMessageAddress(message, "from")?.split("@")[0],
						)}
							color="initials"
						/>
					</div>
					<div className={"flex-1 min-w-0"}>
                        {preview?.calendarEvent && preview?.attendees && preview?.identity && (
                            <RenderInvite calendarEvent={preview.calendarEvent} attendees={preview.attendees ?? []} identity={preview.identity}/>
                        )}

						<EmailRenderer
							threadIndex={threadIndex}
							numberOfMessages={numberOfMessages}
							showSubject={showSubject}
							message={message}
							attachments={attachments}
							inlineShownIds={inlineShownIds}
							publicConfig={publicConfig}
							threadId={threadId}
							markSmtp={markSmtp}
							activeMailboxId={activeMailboxId}
                            mailSubscription={mailSubscription}
							identityMailboxes={identityMailboxes}
							starred={starred}
						>
							<EmailViewer message={message} threadIndex={threadIndex} remoteImagesAllowed={remoteImagesAllowed} cidUrls={cidUrls} />
						</EmailRenderer>
					</div>
				</div>
			</Container>
		</>
	);
}
