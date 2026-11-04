import { db, messageAttachments, workspaceMembers, workspaces } from "@db";
import { and, eq, inArray, or } from "drizzle-orm";

// ss2i (controle d'acces) : garde-fous de l'envoi (server/plugins/send-mail.ts). La charge
// utile vient de plusieurs producteurs (webmail, MCP, API, invitations) ; le worker ne
// suppose plus que le message d'origine et les pieces jointes appartiennent a l'expediteur.

/**
 * Message d'origine (reponse, transfert) utilisable par l'identite d'envoi : du meme
 * workspace. Sinon il est ignore : ni citation, ni rattachement au fil, ni In-Reply-To.
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
 * Cles S3 de pieces jointes autorisees pour un envoi : deposees par le proprietaire de
 * l'identite ou par l'utilisateur qui envoie s'il est membre du workspace (prefixe
 * private/<userId>/, celui de l'editeur, de l'MCP, de l'API et des invitations), ou
 * pieces jointes d'un message du meme workspace (transfert avec pieces jointes).
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
