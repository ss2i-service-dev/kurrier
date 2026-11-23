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

	// ss2i (controle d'acces, GHSA-cvh9-93mg-xvc9) : et seulement ceux du proprietaire de
	// l'identite. Un collegue qui voit une identite partagee pouvait y poser un webhook et
	// recevoir son courrier entrant, meme apres la fin du partage. Proprietaire de l'identite
	// et non de la boite (amont) : un dossier cree par un collegue dans l'identite lui appartient.
	const [identity] = await db
		.select({ ownerId: identities.ownerId })
		.from(identities)
		.where(eq(identities.id, mailbox.identityId));

	if (!identity) return;

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
				eq(webhooks.ownerId, identity.ownerId),
				sql`${webhooks.events} @> '{message.received}'::webhook_list[]`,
				eq(webhooks.enabled, true),
			),
		);

	for (const hook of hooks) {
		try {
			// ss2i (controle d'acces) : adresse publique seulement, reverifiee a la connexion
			// (pas de webhook vers le reseau interne, rebinding DNS compris) ; pas de redirection.
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
