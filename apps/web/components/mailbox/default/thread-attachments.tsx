// "Attachments of the thread" block at the top of the conversation, for both interfaces.
// Read through RLS, stable links (lib/attachment-links.ts): nothing is signed at display time.
import { messageAttachments, MessageEntity } from "@db";
import { getPublicEnv } from "@schema";
import { inArray } from "drizzle-orm";
import { rlsClient } from "@/lib/actions/clients";
import { attachmentUrls } from "@/lib/attachment-links";
import { selectThreadAttachments } from "@/lib/thread-attachments";
import MessageAttachments from "@/components/mailbox/default/message-attachments";

export default async function ThreadAttachments({
	messages,
	className,
}: {
	// Oldest to newest, already deduplicated (thread-dedupe.ts).
	messages: MessageEntity[];
	className?: string;
}) {
	if (messages.length === 0) return null;
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select()
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, messages.map((m) => m.id))),
	);
	const attachments = selectThreadAttachments(messages, rows).map((a) => ({ ...a, ...attachmentUrls(a) }));
	if (attachments.length === 0) return null;
	return (
		<div className={className}>
			<MessageAttachments attachments={attachments} publicConfig={getPublicEnv()} hiddenIds={[]} variant="thread" />
		</div>
	);
}
