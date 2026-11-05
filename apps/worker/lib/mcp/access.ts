import {
	db,
	identities,
	mailboxes,
	mailboxSync,
	mailboxThreads,
	messageAttachments,
	messages,
} from "@db";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";

// Access layer of the mail MCP. Every function starts from the authenticated user
// (userId) and walks up the ownership chain identity -> folder -> thread -> message
// -> attachment: no identifier received from the client is used without this check.
// This is the MCP's main security point: another user's thread, message or attachment
// behaves exactly as if it did not exist.

export class McpToolError extends Error {}

export type Identity = typeof identities.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type MailboxThread = typeof mailboxThreads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Attachment = typeof messageAttachments.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export async function listIdentities(userId: string) {
	return db
		.select()
		.from(identities)
		.where(and(eq(identities.ownerId, userId), eq(identities.kind, "email")))
		.orderBy(asc(identities.createdAt));
}

// One identity by id, publicId or address. With no argument: the default identity if the
// user has only one, otherwise an explicit error.
export async function resolveIdentity(userId: string, ref?: string | null) {
	const own = await listIdentities(userId);
	if (!ref) {
		if (own.length === 1) return own[0];
		if (own.length === 0) throw new McpToolError("No email identity for this user");
		throw new McpToolError(
			`Several identities: specify 'identity' (${own.map((i) => i.value).join(", ")})`,
		);
	}
	const needle = ref.trim().toLowerCase();
	const found = own.find(
		(i) =>
			i.id === ref ||
			i.publicId === ref ||
			i.value.toLowerCase() === needle,
	);
	if (!found) throw new McpToolError(`Identity not found: ${ref}`);
	return found;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listMailboxes(userId: string, identityId: string) {
	const rows = await db
		.select({ mailbox: mailboxes, sync: mailboxSync })
		.from(mailboxes)
		.innerJoin(identities, eq(identities.id, mailboxes.identityId))
		.leftJoin(mailboxSync, eq(mailboxSync.mailboxId, mailboxes.id))
		.where(and(eq(identities.ownerId, userId), eq(mailboxes.identityId, identityId)))
		.orderBy(
			sql`
				CASE ${mailboxes.kind}
				WHEN 'inbox'   THEN 0
				WHEN 'drafts'  THEN 1
				WHEN 'sent'    THEN 2
				WHEN 'archive' THEN 3
				WHEN 'spam'    THEN 4
				WHEN 'trash'   THEN 5
				WHEN 'outbox'  THEN 6
				ELSE 7
				END
			`,
			asc(mailboxes.parentId),
			sql`lower(coalesce(${mailboxes.name}, ''))`,
		);
	return rows.map((r) => ({ ...r.mailbox, imapSynced: Boolean(r.sync) }));
}

// One folder by id, publicId, slug, name or kind, within one of the user's identities.
export async function resolveMailbox(
	userId: string,
	identityId: string,
	ref: string,
) {
	const list = await listMailboxes(userId, identityId);
	const needle = ref.trim().toLowerCase();
	const found =
		list.find((m) => m.id === ref || m.publicId === ref) ??
		list.find((m) => (m.slug ?? "").toLowerCase() === needle) ??
		list.find((m) => (m.name ?? "").toLowerCase() === needle) ??
		list.find((m) => m.kind === needle);
	if (!found) throw new McpToolError(`Folder not found: ${ref}`);
	return found;
}

// Folder by id alone (identity not known), always bounded to the user.
export async function getOwnedMailbox(userId: string, mailboxId: string) {
	if (!isUuid(mailboxId)) throw new McpToolError(`Invalid folder id: ${mailboxId}`);
	const [row] = await db
		.select({ mailbox: mailboxes, sync: mailboxSync, identity: identities })
		.from(mailboxes)
		.innerJoin(identities, eq(identities.id, mailboxes.identityId))
		.leftJoin(mailboxSync, eq(mailboxSync.mailboxId, mailboxes.id))
		.where(and(eq(mailboxes.id, mailboxId), eq(identities.ownerId, userId)))
		.limit(1);
	if (!row) throw new McpToolError(`Folder not found: ${mailboxId}`);
	return { ...row.mailbox, imapSynced: Boolean(row.sync), identity: row.identity };
}

export async function unreadCountsByMailbox(userId: string, identityId: string) {
	const now = new Date();
	const rows = await db
		.select({
			mailboxId: mailboxThreads.mailboxId,
			unreadThreads: sql<number>`count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)`,
			unreadTotal: sql<number>`coalesce(sum(${mailboxThreads.unreadCount}), 0)`,
			threads: sql<number>`count(*)`,
		})
		.from(mailboxThreads)
		.where(
			and(
				eq(mailboxThreads.ownerId, userId),
				eq(mailboxThreads.identityId, identityId),
				or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
			),
		)
		.groupBy(mailboxThreads.mailboxId);
	return new Map(
		rows.map((r) => [
			r.mailboxId,
			{
				unreadThreads: Number(r.unreadThreads ?? 0),
				unreadTotal: Number(r.unreadTotal ?? 0),
				threads: Number(r.threads ?? 0),
			},
		]),
	);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

// Same order as fetchMailboxThreads (web): effective activity descending, snoozed threads
// excluded.
export async function listThreads(opts: {
	userId: string;
	mailboxId: string;
	limit: number;
	offset: number;
	unreadOnly?: boolean;
	starredOnly?: boolean;
}) {
	const now = new Date();
	const effectiveActivityAt = sql`COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt})`;
	const conditions = [
		eq(mailboxThreads.ownerId, opts.userId),
		eq(mailboxThreads.mailboxId, opts.mailboxId),
		or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
	];
	if (opts.unreadOnly) conditions.push(gt(mailboxThreads.unreadCount, 0));
	if (opts.starredOnly) conditions.push(eq(mailboxThreads.starred, true));
	return db
		.select()
		.from(mailboxThreads)
		.where(and(...conditions))
		.orderBy(
			desc(effectiveActivityAt),
			desc(mailboxThreads.lastActivityAt),
			desc(mailboxThreads.threadId),
		)
		.offset(opts.offset)
		.limit(opts.limit + 1);
}

// All the mailbox_threads rows of a thread belonging to the user (a thread can appear in
// several folders: inbox and sent, for example).
export async function threadPlacements(userId: string, threadIds: string[]) {
	const ids = threadIds.filter(isUuid);
	if (!ids.length) return [];
	return db
		.select({ placement: mailboxThreads, mailbox: mailboxes, sync: mailboxSync })
		.from(mailboxThreads)
		.innerJoin(mailboxes, eq(mailboxes.id, mailboxThreads.mailboxId))
		.leftJoin(mailboxSync, eq(mailboxSync.mailboxId, mailboxes.id))
		.where(and(eq(mailboxThreads.ownerId, userId), inArray(mailboxThreads.threadId, ids)));
}

// Source folder of an action on threads: the requested one (folder), otherwise the only
// "live" folder where each thread is. Ambiguous -> error listing the folders.
export async function resolveActionTargets(opts: {
	userId: string;
	threadIds: string[];
	folder?: string | null;
	identity?: string | null;
	excludeKinds?: string[];
}) {
	const placements = await threadPlacements(opts.userId, opts.threadIds);
	const byThread = new Map<string, typeof placements>();
	for (const p of placements) {
		const list = byThread.get(p.placement.threadId) ?? [];
		list.push(p);
		byThread.set(p.placement.threadId, list);
	}
	// Group { mailboxId -> threadIds } to post one job per source folder.
	const groups = new Map<
		string,
		{ mailbox: Mailbox; imapSynced: boolean; threadIds: string[] }
	>();
	const missing: string[] = [];
	const ambiguous: string[] = [];
	for (const threadId of new Set(opts.threadIds)) {
		let rows = byThread.get(threadId) ?? [];
		if (!rows.length) {
			missing.push(threadId);
			continue;
		}
		if (opts.folder) {
			const needle = opts.folder.trim().toLowerCase();
			rows = rows.filter(
				(r) =>
					r.mailbox.id === opts.folder ||
					r.mailbox.publicId === opts.folder ||
					(r.mailbox.slug ?? "").toLowerCase() === needle ||
					(r.mailbox.name ?? "").toLowerCase() === needle ||
					r.mailbox.kind === needle,
			);
			if (!rows.length) {
				missing.push(`${threadId} (not in folder ${opts.folder})`);
				continue;
			}
		} else {
			const exclude = new Set(opts.excludeKinds ?? ["sent", "trash", "drafts", "outbox"]);
			const live = rows.filter((r) => !exclude.has(r.mailbox.kind));
			if (live.length) rows = live;
			if (rows.length > 1) {
				ambiguous.push(
					`${threadId} (in ${rows.map((r) => r.mailbox.slug ?? r.mailbox.name).join(", ")})`,
				);
				continue;
			}
		}
		const r = rows[0];
		const g = groups.get(r.mailbox.id) ?? {
			mailbox: r.mailbox,
			imapSynced: Boolean(r.sync),
			threadIds: [],
		};
		g.threadIds.push(threadId);
		groups.set(r.mailbox.id, g);
	}
	if (missing.length) throw new McpToolError(`Thread not found: ${missing.join("; ")}`);
	if (ambiguous.length) {
		throw new McpToolError(
			`Thread in several folders, pass 'folder': ${ambiguous.join("; ")}`,
		);
	}
	return Array.from(groups.values());
}

// Messages of a thread, in the folders of the user's identities, in chronological order
// (same order as fetchWebMailThreadDetail).
export async function threadMessages(userId: string, threadId: string) {
	if (!isUuid(threadId)) throw new McpToolError(`Invalid thread id: ${threadId}`);
	const rows = await db
		.select({ message: messages, mailbox: mailboxes })
		.from(messages)
		.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
		.innerJoin(identities, eq(identities.id, mailboxes.identityId))
		.where(and(eq(messages.threadId, threadId), eq(identities.ownerId, userId)))
		.orderBy(asc(sql`coalesce(${messages.date}, ${messages.createdAt})`));
	if (!rows.length) throw new McpToolError(`Thread not found: ${threadId}`);
	return rows;
}

// One message by id, with its folder and identity, bounded to the user.
export async function getOwnedMessage(userId: string, messageId: string) {
	if (!isUuid(messageId)) throw new McpToolError(`Invalid message id: ${messageId}`);
	const [row] = await db
		.select({ message: messages, mailbox: mailboxes, identity: identities })
		.from(messages)
		.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
		.innerJoin(identities, eq(identities.id, mailboxes.identityId))
		.where(and(eq(messages.id, messageId), eq(identities.ownerId, userId)))
		.limit(1);
	if (!row) throw new McpToolError(`Message not found: ${messageId}`);
	return row;
}

export async function attachmentsForMessages(userId: string, messageIds: string[]) {
	const ids = messageIds.filter(isUuid);
	if (!ids.length) return [];
	return db
		.select({ attachment: messageAttachments })
		.from(messageAttachments)
		.innerJoin(messages, eq(messages.id, messageAttachments.messageId))
		.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
		.innerJoin(identities, eq(identities.id, mailboxes.identityId))
		.where(and(inArray(messageAttachments.messageId, ids), eq(identities.ownerId, userId)))
		.orderBy(asc(messageAttachments.createdAt))
		.then((rows) => rows.map((r) => r.attachment));
}

export async function getOwnedAttachment(userId: string, attachmentId: string) {
	if (!isUuid(attachmentId)) throw new McpToolError(`Invalid attachment id: ${attachmentId}`);
	const [row] = await db
		.select({ attachment: messageAttachments })
		.from(messageAttachments)
		.innerJoin(messages, eq(messages.id, messageAttachments.messageId))
		.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
		.innerJoin(identities, eq(identities.id, mailboxes.identityId))
		.where(and(eq(messageAttachments.id, attachmentId), eq(identities.ownerId, userId)))
		.limit(1);
	if (!row) throw new McpToolError(`Attachment not found: ${attachmentId}`);
	return row.attachment;
}

// SQL fallback for search when Typesense does not answer: subject, preview and
// participants of the user's threads.
export async function searchThreadsSql(opts: {
	userId: string;
	identityIds: string[];
	mailboxId?: string | null;
	query: string;
	limit: number;
}) {
	const now = new Date();
	const pattern = `%${opts.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
	const conditions = [
		eq(mailboxThreads.ownerId, opts.userId),
		inArray(mailboxThreads.identityId, opts.identityIds),
		or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
		or(
			ilike(mailboxThreads.subject, pattern),
			ilike(mailboxThreads.previewText, pattern),
			sql`${mailboxThreads.participants}::text ILIKE ${pattern}`,
		),
	];
	if (opts.mailboxId) conditions.push(eq(mailboxThreads.mailboxId, opts.mailboxId));
	return db
		.select()
		.from(mailboxThreads)
		.where(and(...conditions))
		.orderBy(desc(mailboxThreads.lastActivityAt))
		.limit(opts.limit);
}
