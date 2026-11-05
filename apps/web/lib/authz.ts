import "server-only";

// Access checks for server actions. Server module WITHOUT "use server": its functions must
// not become callable actions. Each check throws an Error on refusal and returns what it
// re-read through RLS (rlsClient verifies membership of the workspace in the cookie): that,
// and never the object or identifier coming from the client, is what then goes to the
// worker. Model: deleteForever (mailbox.ts, upstream).
import { isSignedIn } from "@/lib/actions/auth";
import { getWorkspaceId, rlsClient, rlsClientForWorkspace } from "@/lib/actions/clients";
import { identities, mailboxes, messageAttachments, messages } from "@db";
import { and, eq, inArray } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export async function assertSignedIn() {
	const user = await isSignedIn();
	if (!user?.id) throw new Error("Unauthorized");
	return user;
}

// Workspace of the cookie, once it is verified that the signed-in user is a member of it
// (the cookie is set client-side: it proves nothing alone).
export async function assertWorkspace() {
	const workspaceId = await getWorkspaceId();
	if (!isUuid(workspaceId)) throw new Error("No workspace selected");
	await rlsClientForWorkspace(workspaceId);
	return workspaceId;
}

// Visible mailbox: belongs to the workspace and to an identity the user sees (same join
// as deleteForever).
export async function assertMailboxAccess(mailboxId: string) {
	if (!isUuid(mailboxId)) throw new Error("Mailbox not found or access denied");
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ mailbox: mailboxes })
			.from(mailboxes)
			.innerJoin(identities, eq(mailboxes.identityId, identities.id))
			.where(eq(mailboxes.id, mailboxId))
			.limit(1),
	);
	if (!row) throw new Error("Mailbox not found or access denied");
	return row.mailbox;
}

// Verified mailbox, then the requested threads that have at least one message in that
// mailbox. The others are dropped without error: the worker (mail:move, mail:set-flags)
// only acts on messages of the source mailbox and already ignored them (selection of
// threads from several mailboxes, list stale after an IMAP sync).
export async function assertThreadsInMailbox(mailboxId: string, threadIds: string[]) {
	const mailbox = await assertMailboxAccess(mailboxId);
	const requested = Array.from(new Set(threadIds.map(String).filter(isUuid)));
	if (!requested.length) return { mailbox, threadIds: [] as string[] };
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.selectDistinct({ threadId: messages.threadId })
			.from(messages)
			.where(and(eq(messages.mailboxId, mailbox.id), inArray(messages.threadId, requested))),
	);
	const found = new Set(rows.map((r) => String(r.threadId)));
	return { mailbox, threadIds: requested.filter((id) => found.has(id)) };
}

export async function assertIdentityAccess(ref: { id: string } | { publicId: string }) {
	const byId = "id" in ref;
	const value = String(byId ? ref.id : ref.publicId ?? "");
	if (!value || (byId && !isUuid(value))) throw new Error("Identity not found or access denied");
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx
			.select()
			.from(identities)
			.where(byId ? eq(identities.id, value) : eq(identities.publicId, value))
			.limit(1),
	);
	if (!identity) throw new Error("Identity not found or access denied");
	return identity;
}

// Message of a visible mailbox (workspace and identity, like assertMailboxAccess).
export async function assertMessageAccess(messageId: string) {
	if (!isUuid(messageId)) throw new Error("Message not found or access denied");
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ message: messages })
			.from(messages)
			.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
			.innerJoin(identities, eq(mailboxes.identityId, identities.id))
			.where(eq(messages.id, messageId))
			.limit(1),
	);
	if (!row) throw new Error("Message not found or access denied");
	return row.message;
}

// The messageId and the extension of a file go into the S3 keys of attachment uploads:
// neither "/" nor ".." may let the key escape private/<userId>/.
export const isSafeKeySegment = (v: unknown) => /^[A-Za-z0-9_-]{1,64}$/.test(String(v ?? ""));
export const safeExtension = (fileName: string) => {
	const ext = fileName.includes(".") ? String(fileName.split(".").pop()) : "";
	return /^[A-Za-z0-9]{1,12}$/.test(ext) ? ext : "";
};

// S3 key of an attachment: uploaded by the user (private/<userId>/..., prefix of
// createAttachmentUploadUrl, k-uploads and the MCP), or attachment of a message of the
// workspace (forward with attachments, draft created by the MCP).
export async function assertOwnedS3Key(key: string, userId: string) {
	const k = String(key ?? "");
	const segments = k.split("/");
	if (
		!k ||
		k.length > 1024 ||
		k.includes("\\") ||
		segments.some((s) => s === "" || s === "." || s === "..")
	) {
		throw new Error("Invalid storage key");
	}
	if (userId && segments[0] === "private" && segments[1] === userId && segments.length > 2) {
		return k;
	}
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ path: messageAttachments.path })
			.from(messageAttachments)
			.where(eq(messageAttachments.path, k))
			.limit(1),
	);
	if (!row) throw new Error("Attachment not found or access denied");
	return k;
}
