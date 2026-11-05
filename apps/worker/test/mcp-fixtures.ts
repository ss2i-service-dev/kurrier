import {
	db,
	identities,
	mailboxThreads,
	mailboxes,
	messageAttachments,
	messages,
	threads,
	users,
	workspaces,
} from "@db";

// Two users, each with their own workspace, an identity, an inbox, a Sent folder and a
// one-message thread with an attachment.
export async function createUserFixture(tag: string) {
	const email = `${tag}-${Date.now()}@test.invalid`;
	const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
	const [workspace] = await db
		.insert(workspaces)
		.values({ ownerId: user.id, name: `ws-${tag}` })
		.returning();
	const [identity] = await db
		.insert(identities)
		.values({ ownerId: user.id, workspaceId: workspace.id, kind: "email", value: email, status: "verified" })
		.returning();
	const box = async (kind: "inbox" | "sent" | "trash" | "drafts", name: string) => {
		const [row] = await db
			.insert(mailboxes)
			.values({
				ownerId: user.id,
				workspaceId: workspace.id,
				identityId: identity.id,
				kind,
				name,
				slug: kind,
				isDefault: true,
				metaData: {},
			})
			.returning();
		return row;
	};
	const inbox = await box("inbox", "Inbox");
	const sent = await box("sent", "Sent");
	const drafts = await box("drafts", "Drafts");
	const [thread] = await db
		.insert(threads)
		.values({ ownerId: user.id, workspaceId: workspace.id, lastMessageDate: new Date() })
		.returning();
	const [message] = await db
		.insert(messages)
		.values({
			ownerId: user.id,
			workspaceId: workspace.id,
			mailboxId: inbox.id,
			threadId: thread.id,
			messageId: `<${tag}-${Date.now()}@test.invalid>`,
			subject: `Secret of ${tag}`,
			text: `Body only ${tag} may read`,
			html: `<p>Body only <b>${tag}</b> may read</p>`,
			from: { value: [{ address: `sender-${tag}@test.invalid`, name: "Sender" }], html: "", text: "" },
			to: { value: [{ address: email, name: "" }], html: "", text: "" },
			date: new Date(),
			seen: false,
		})
		.returning();
	await db.insert(mailboxThreads).values({
		threadId: thread.id,
		mailboxId: inbox.id,
		ownerId: user.id,
		identityId: identity.id,
		identityPublicId: identity.publicId,
		mailboxSlug: "inbox",
		subject: message.subject,
		previewText: message.text,
		lastActivityAt: new Date(),
		firstMessageAt: new Date(),
		messageCount: 1,
		unreadCount: 1,
		workspaceId: workspace.id,
	});
	const [attachment] = await db
		.insert(messageAttachments)
		.values({
			ownerId: user.id,
			workspaceId: workspace.id,
			messageId: message.id,
			bucketId: "kurrier-test",
			path: `private/${user.id}/${message.id}/${tag}.txt`,
			filenameOriginal: `${tag}.txt`,
			contentType: "text/plain",
			sizeBytes: 12,
		})
		.returning();
	return { user, workspace, identity, inbox, sent, drafts, thread, message, attachment, email };
}
