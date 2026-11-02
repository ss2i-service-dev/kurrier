import React from "react";
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
import { getMessageAddress, getMessageName } from "@common/mail-client";
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
	threadId,
	activeMailboxId,
	markSmtp,
    identityPublicId,
    mailSubscription
}: {
	message: MessageEntity;
	threadIndex: number;
	numberOfMessages: number;
	threadId: string;
	activeMailboxId: string;
	markSmtp: boolean;
    identityPublicId: string;
    mailSubscription: FetchThreadMailSubsResult["byMessageId"] | null;
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
	const remoteImagesAllowed = await remoteImagesAllowedForContact(
		getMessageAddress(message, "from"),
	);

	return (
		<>
			<Container variant="wide">
				<div className={"grid grid-cols-12 p-3"}>
					<div className={"hidden md:block md:col-span-1 pt-4"}>
						<Avatar
							size="lg"
							radius="xl"
							name={
								getMessageName(message, "from") ||
								getMessageAddress(message, "from") ||
								""
							}
							color="initials"
						/>
					</div>
					<div className={"col-span-12 md:col-span-11"}>
                        {preview?.calendarEvent && preview?.attendees && preview?.identity && (
                            <RenderInvite calendarEvent={preview.calendarEvent} attendees={preview.attendees ?? []} identity={preview.identity}/>
                        )}

						<EmailRenderer
							threadIndex={threadIndex}
							numberOfMessages={numberOfMessages}
							message={message}
							attachments={attachments}
							publicConfig={publicConfig}
							threadId={threadId}
							markSmtp={markSmtp}
							activeMailboxId={activeMailboxId}
                            mailSubscription={mailSubscription}
							identityMailboxes={identityMailboxes}
						>
							<EmailViewer message={message} remoteImagesAllowed={remoteImagesAllowed} />
						</EmailRenderer>
					</div>
				</div>
			</Container>
		</>
	);
}
