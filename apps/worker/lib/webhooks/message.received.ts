import { db, mailboxes, MessageEntity, webhooks } from "@db";
import { and, eq, sql } from "drizzle-orm";
import { publicHttpRequest } from "@common/safe-http";

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

	// Access control: only the webhooks of the mailbox's identity, within its workspace. A
	// webhook without an identity (or from another workspace) would receive all incoming mail
	// of every mailbox of the instance.
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
			// Access control: public address only, re-checked at connection time (no webhook to the
			// internal network, DNS rebinding included); no redirects.
			await publicHttpRequest(hook.url, {
				method: "POST",
				allowHttp: true,
				timeoutMs: 10_000,
				headers: { "Content-Type": "application/json" },
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
