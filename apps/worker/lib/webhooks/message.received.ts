import { db, identities, mailboxes, MessageEntity, webhooks } from "@db";
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

	// Access control (GHSA-cvh9-93mg-xvc9): and only those of the identity's owner. A colleague
	// who sees a shared identity could add a webhook on it and receive its incoming mail, even
	// after the sharing ended. The owner of the identity, not of the mailbox: a folder created
	// by a colleague in the identity belongs to that colleague.
	const [identity] = await db
		.select({ ownerId: identities.ownerId })
		.from(identities)
		.where(eq(identities.id, mailbox.identityId));

	if (!identity) return;

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
				eq(webhooks.ownerId, identity.ownerId),
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
