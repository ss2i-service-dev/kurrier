import { db, mailboxes, MessageEntity, webhooks } from "@db";
import { and, eq, sql } from "drizzle-orm";

export const processWebhook = async ({
	message,
	rawEmail,
}: {
	message: MessageEntity;
	rawEmail: string;
}) => {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, message.mailboxId));

	if (!mailbox) return;

	// ss2i (controle d'acces) : seulement les webhooks de l'identite de la boite, dans son
	// workspace. Un webhook sans identite (ou d'un autre workspace) recevait tout le courrier
	// entrant de toutes les boites de l'instance.
	const hooks = await db
		.select()
		.from(webhooks)
		.where(
			and(
				eq(webhooks.identityId, mailbox.identityId),
				eq(webhooks.workspaceId, mailbox.workspaceId),
				sql`${webhooks.events} @> '{message.received}'::webhook_list[]`,
				eq(webhooks.enabled, true),
			),
		);

	for (const hook of hooks) {
		try {
			await fetch(hook.url, {
				method: "POST",
				body: JSON.stringify({
					event: "message.received",
					data: {
						message,
						rawEmail,
					},
				}),
			});
		} catch (err) {
			console.error(
				`Error sending webhook to ${hook.url}: `,
				(err as Error).message,
			);
		}
	}
};
