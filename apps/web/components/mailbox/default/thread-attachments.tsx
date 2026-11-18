// ss2i : bloc « pieces jointes du fil » en haut de la conversation, pour les deux interfaces.
// Lecture par RLS, liens stables (lib/attachment-links.ts) : rien n'est signe a l'affichage.
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
	// Du plus ancien au plus recent, deja dedoublonnes (thread-dedupe.ts).
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
