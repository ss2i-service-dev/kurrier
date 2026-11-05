import React from "react";
import { MessageEntity } from "@db";
import { getPublicEnv } from "@schema";
import { getMessageAddress } from "@common/mail-client";
import { cidUrlMap, inlineImageIdsShownInBody } from "@/lib/inline-images";
import {
	fetchIdentityMailboxList,
	FetchThreadMailSubsResult,
	getSignedUrlsForMessage,
} from "@/lib/actions/mailbox";
import { fetchEventPreviewItems } from "@/lib/actions/calendar";
import { remoteImagesAllowedForContact } from "@/lib/actions/contact-images";
import { fetchDraftOriginal } from "@/lib/actions/drafts";
import EmailViewer from "@/components/mailbox/default/email-viewer";
import RenderInvite from "@/components/mailbox/default/render-invite";
import DraftThreadItem from "@/components/mailbox/default/draft-thread-item";
import KMessage from "@/components/k/message";

// One message of the thread, server side. Same data as
// components/mailbox/default/thread-item.tsx (draft opened in the editor,
// inline images not repeated, cid: resolved, invitations), rendered by KMessage;
// queries run in parallel and the identity list is provided by the page.
export default async function KThreadItem({
	message,
	threadIndex,
	numberOfMessages,
	threadId,
	activeMailboxId,
	markSmtp,
	identityPublicId,
	mailSubscription,
	defaultExpanded = true,
	identityMailboxes: identityMailboxesProp,
}: {
	message: MessageEntity;
	threadIndex: number;
	numberOfMessages: number;
	threadId: string;
	activeMailboxId: string;
	markSmtp: boolean;
	identityPublicId: string;
	mailSubscription: FetchThreadMailSubsResult["byMessageId"] | null;
	defaultExpanded?: boolean;
	identityMailboxes?: Awaited<ReturnType<typeof fetchIdentityMailboxList>>;
}) {
	const publicConfig = getPublicEnv();
	const identityMailboxes = identityMailboxesProp ?? (await fetchIdentityMailboxList());

	// A draft opens in the editor, not in the reader (as in the classic interface).
	if (message.draft) {
		const original = await fetchDraftOriginal((message.metaData as any)?.draft?.originalMessageId);
		return (
			<div className="k-msg-card rounded-k-pane border border-k-line bg-k-surface px-4 py-3">
				<DraftThreadItem draft={message} original={original} publicConfig={publicConfig} identityMailboxes={identityMailboxes} />
			</div>
		);
	}

	const [attachments, remoteImagesAllowed] = await Promise.all([
		getSignedUrlsForMessage(message.id),
		remoteImagesAllowedForContact(getMessageAddress(message, "from")),
	]);
	const preview = attachments?.length ? await fetchEventPreviewItems(attachments, identityPublicId) : null;
	const inlineShownIds = Array.from(inlineImageIdsShownInBody(message.html, attachments));
	const cidUrls = cidUrlMap(attachments);

	return (
		<KMessage
			threadIndex={threadIndex}
			numberOfMessages={numberOfMessages}
			message={message}
			attachments={attachments}
			inlineShownIds={inlineShownIds}
			publicConfig={publicConfig}
			threadId={threadId}
			markSmtp={markSmtp}
			activeMailboxId={activeMailboxId}
			mailSubscription={mailSubscription}
			identityMailboxes={identityMailboxes}
			defaultExpanded={defaultExpanded}
			invite={
				preview?.calendarEvent && preview?.attendees && preview?.identity ? (
					<RenderInvite calendarEvent={preview.calendarEvent} attendees={preview.attendees ?? []} identity={preview.identity} />
				) : null
			}
		>
			<EmailViewer message={message} remoteImagesAllowed={remoteImagesAllowed} cidUrls={cidUrls} adaptTheme />
		</KMessage>
	);
}
