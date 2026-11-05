import { db, messageAttachments, workspaceMembers, workspaces } from "@db";
import { and, eq, inArray, or } from "drizzle-orm";

// Access control: send guards (server/plugins/send-mail.ts). The payload comes from several
// producers (webmail, MCP, API, invitations); the worker does not assume that the original
// message and the attachments belong to the sender.

/**
 * Original message (reply, forward) usable by the sending identity: from the same
 * workspace. Otherwise it is ignored: no quoting, no thread attachment, no In-Reply-To.
 */
export function originalUsableBy(
	orig: { workspaceId: string | null } | null | undefined,
	sending: { workspaceId: string },
) {
	return !!orig?.workspaceId && orig.workspaceId === sending.workspaceId;
}

const validKey = (key: string) => {
	const segments = key.split("/");
	return (
		key.length > 0 &&
		key.length <= 1024 &&
		!key.includes("\\") &&
		!segments.some((s) => s === "" || s === "." || s === "..")
	);
};

/**
 * S3 keys of attachments allowed for a send: uploaded by the identity's owner or by the
 * sending user if a member of the workspace (prefix private/<userId>/, used by the editor,
 * the MCP, the API and invitations), or attachments of a message of the same workspace
 * (forward with attachments).
 */
export async function allowedAttachmentKeys(
	keys: string[],
	ctx: { workspaceId: string; identityOwnerId: string; senderUserId?: string | null },
): Promise<Set<string>> {
	const allowed = new Set<string>();
	const candidates = Array.from(new Set(keys.map(String))).filter(validKey);
	if (!candidates.length) return allowed;

	const owners = new Set([ctx.identityOwnerId]);
	const sender = String(ctx.senderUserId ?? "");
	if (sender && sender !== ctx.identityOwnerId) {
		const [member] = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.leftJoin(
				workspaceMembers,
				and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, sender)),
			)
			.where(
				and(
					eq(workspaces.id, ctx.workspaceId),
					or(eq(workspaces.ownerId, sender), eq(workspaceMembers.userId, sender)),
				),
			)
			.limit(1);
		if (member) owners.add(sender);
	}

	const rest: string[] = [];
	for (const key of candidates) {
		const [root, owner] = key.split("/");
		if (root === "private" && owners.has(owner) && key.split("/").length > 2) allowed.add(key);
		else rest.push(key);
	}
	if (rest.length) {
		const rows = await db
			.select({ path: messageAttachments.path })
			.from(messageAttachments)
			.where(
				and(
					eq(messageAttachments.workspaceId, ctx.workspaceId),
					inArray(messageAttachments.path, rest),
				),
			);
		for (const r of rows) if (r.path) allowed.add(r.path);
	}
	return allowed;
}
