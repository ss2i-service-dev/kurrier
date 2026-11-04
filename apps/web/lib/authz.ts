import "server-only";

// ss2i : controles d'acces des actions serveur (audit du 2026-11-04). Module serveur SANS
// "use server" : ses fonctions ne doivent pas devenir des actions appelables. Chaque
// controle leve une Error en cas de refus et rend ce qu'il a relu a travers RLS
// (rlsClient verifie l'appartenance au workspace du cookie) : c'est cela, et jamais
// l'objet ou l'identifiant venu du client, qui part ensuite vers le worker.
// Modele : deleteForever (mailbox.ts, amont d533d672).
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

// Workspace du cookie, une fois verifie que l'utilisateur connecte en est membre (le cookie
// se pose cote client : il ne prouve rien seul).
export async function assertWorkspace() {
	const workspaceId = await getWorkspaceId();
	if (!isUuid(workspaceId)) throw new Error("No workspace selected");
	await rlsClientForWorkspace(workspaceId);
	return workspaceId;
}

// Dossier visible : du workspace, et d'une identite que l'utilisateur voit (meme jointure
// que deleteForever).
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

// Dossier verifie, puis les fils demandes qui ont au moins un message dans ce dossier. Les
// autres sont retires sans erreur : le worker (mail:move, mail:set-flags) n'agit que sur
// les messages du dossier source et les ignorait deja (vue Clients : selection de fils de
// plusieurs dossiers, liste perimee apres une synchro IMAP).
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

// Message d'un dossier visible (workspace et identite, comme assertMailboxAccess).
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

// Le messageId et l'extension d'un fichier entrent dans les cles S3 d'envoi de pieces
// jointes : ni « / » ni « .. » ne doivent pouvoir faire sortir la cle de private/<userId>/.
export const isSafeKeySegment = (v: unknown) => /^[A-Za-z0-9_-]{1,64}$/.test(String(v ?? ""));
export const safeExtension = (fileName: string) => {
	const ext = fileName.includes(".") ? String(fileName.split(".").pop()) : "";
	return /^[A-Za-z0-9]{1,12}$/.test(ext) ? ext : "";
};

// Cle S3 d'une piece jointe : deposee par l'utilisateur (private/<userId>/..., prefixe de
// createAttachmentUploadUrl, k-uploads et de l'MCP), ou piece jointe d'un message du
// workspace (transfert avec pieces jointes, brouillon cree par l'MCP).
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
