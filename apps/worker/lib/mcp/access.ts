import {
	crmCompanies,
	db,
	identities,
	mailboxes,
	mailboxSync,
	mailboxThreads,
	messageAttachments,
	messages,
	threadClients,
} from "@db";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";

// Couche d'acces de l'MCP courrier. Chaque fonction part de l'utilisateur authentifie
// (userId) et remonte la chaine d'appartenance identite -> dossier -> fil -> message
// -> piece jointe : aucun identifiant recu du client n'est utilise sans ce controle.
// C'est le point de securite principal de l'MCP : un fil, un message ou une piece
// jointe d'un autre utilisateur se comporte exactement comme s'il n'existait pas.

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
// Identites
// ---------------------------------------------------------------------------

export async function listIdentities(userId: string) {
	return db
		.select()
		.from(identities)
		.where(and(eq(identities.ownerId, userId), eq(identities.kind, "email")))
		.orderBy(asc(identities.createdAt));
}

// Une identite par id, publicId ou adresse. Sans argument : l'identite par defaut si
// l'utilisateur n'en a qu'une, sinon erreur explicite.
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
// Dossiers
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

// Un dossier par id, publicId, slug, nom ou kind, dans une identite de l'utilisateur.
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

// Dossier par id seul (sans identite connue), toujours borne a l'utilisateur.
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
// Fils
// ---------------------------------------------------------------------------

// Meme ordre que fetchMailboxThreads (web) : activite effective decroissante, fils
// mis en veille exclus.
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

// Toutes les lignes mailbox_threads d'un fil appartenant a l'utilisateur (un fil peut
// figurer dans plusieurs dossiers : boite de reception et envoyes, par exemple).
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

// Dossier source d'une action sur des fils : celui demande (folder), sinon le seul
// dossier « vivant » ou se trouve chaque fil. Ambigu -> erreur qui liste les dossiers.
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
	// Groupe { mailboxId -> threadIds } pour poster un job par dossier source.
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

// Messages d'un fil, dans les dossiers d'identites de l'utilisateur, ordre
// chronologique (meme ordre que fetchWebMailThreadDetail).
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

// Un message par id, avec son dossier et son identite, borne a l'utilisateur.
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

// Repli SQL de la recherche quand Typesense ne repond pas : sujet, apercu et
// participants des fils de l'utilisateur.
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

// ---------------------------------------------------------------------------
// Clients (section « Clients » des boites pro : fils rattaches aux societes de la CRM)
// ---------------------------------------------------------------------------

// Societes d'une identite de l'utilisateur, derniere activite en premier, avec le
// nombre de fils (hors corbeille et spam, hors fils detaches a la main). `query`
// filtre sur le nom.
export async function listClients(opts: { userId: string; identityId: string; query?: string | null; limit: number }) {
	const q = (opts.query ?? "").trim();
	const conditions = [
		eq(threadClients.ownerId, opts.userId),
		eq(threadClients.identityId, opts.identityId),
		eq(threadClients.detached, false),
		liveThreadCondition,
	];
	if (q) conditions.push(ilike(crmCompanies.name, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
	return db
		.select({
			companyId: threadClients.crmCompanyId,
			name: crmCompanies.name,
			ebpCustomerId: crmCompanies.ebpCustomerId,
			threadCount: sql<number>`count(*)`,
			lastActivityAt: sql<Date>`max(${threadClients.lastActivityAt})`,
		})
		.from(threadClients)
		.innerJoin(crmCompanies, eq(crmCompanies.id, threadClients.crmCompanyId))
		.where(and(...conditions))
		.groupBy(threadClients.crmCompanyId, crmCompanies.name, crmCompanies.ebpCustomerId)
		.orderBy(desc(sql`max(${threadClients.lastActivityAt})`), asc(crmCompanies.name))
		.limit(opts.limit);
}

// Le fil a encore une place hors corbeille et spam dans les dossiers de l'identite.
const liveThreadCondition = sql`EXISTS (
	SELECT 1 FROM mailbox_threads mt
	JOIN mailboxes mb ON mb.id = mt.mailbox_id
	WHERE mt.thread_id = ${threadClients.threadId}
	  AND mt.identity_id = ${threadClients.identityId}
	  AND mb.kind NOT IN ('trash', 'spam')
)`;

// Fils d'un client pour une identite de l'utilisateur : une ligne mailbox_threads par
// fil (sa place la plus recente hors corbeille et spam), derniere activite en premier.
export async function listClientThreads(opts: {
	userId: string;
	identityId: string;
	companyId: number;
	limit: number;
	offset: number;
}) {
	const ranked = db
		.select({
			threadId: mailboxThreads.threadId,
			mailboxId: mailboxThreads.mailboxId,
			rn: sql<number>`row_number() over (partition by ${mailboxThreads.threadId} order by ${mailboxThreads.lastActivityAt} desc, ${mailboxThreads.mailboxId})`.as("rn"),
		})
		.from(threadClients)
		.innerJoin(
			mailboxThreads,
			and(eq(mailboxThreads.threadId, threadClients.threadId), eq(mailboxThreads.identityId, threadClients.identityId)),
		)
		.innerJoin(mailboxes, and(eq(mailboxes.id, mailboxThreads.mailboxId), sql`${mailboxes.kind} NOT IN ('trash', 'spam')`))
		.where(
			and(
				eq(threadClients.ownerId, opts.userId),
				eq(threadClients.identityId, opts.identityId),
				eq(threadClients.crmCompanyId, opts.companyId),
				eq(threadClients.detached, false),
			),
		)
		.as("ranked");
	return db
		.select({ thread: mailboxThreads })
		.from(ranked)
		.innerJoin(mailboxThreads, and(eq(mailboxThreads.threadId, ranked.threadId), eq(mailboxThreads.mailboxId, ranked.mailboxId)))
		.where(and(eq(ranked.rn, 1), eq(mailboxThreads.ownerId, opts.userId)))
		.orderBy(desc(mailboxThreads.lastActivityAt), desc(mailboxThreads.threadId))
		.offset(opts.offset)
		.limit(opts.limit + 1)
		.then((rows) => rows.map((r) => r.thread));
}

// Clients connus d'une liste de fils de l'utilisateur, pour decorer les listes.
export async function clientsForThreads(userId: string, threadIds: string[]) {
	const ids = Array.from(new Set(threadIds.filter(isUuid)));
	const out = new Map<string, { client_id: number; name: string }[]>();
	if (!ids.length) return out;
	const rows = await db
		.select({ threadId: threadClients.threadId, companyId: threadClients.crmCompanyId, name: crmCompanies.name })
		.from(threadClients)
		.innerJoin(crmCompanies, eq(crmCompanies.id, threadClients.crmCompanyId))
		.where(and(eq(threadClients.ownerId, userId), eq(threadClients.detached, false), inArray(threadClients.threadId, ids)))
		.orderBy(asc(crmCompanies.name));
	for (const r of rows) {
		const list = out.get(r.threadId) ?? [];
		if (!list.some((c) => c.client_id === r.companyId)) list.push({ client_id: r.companyId, name: r.name });
		out.set(r.threadId, list);
	}
	return out;
}

// ss2i : rattachement manuel (outils link_thread_to_client, unlink_thread_from_client). Fils
// de la liste qui ont une place dans l'identite de l'utilisateur ; les autres sont ignores,
// comme s'ils n'existaient pas.
export async function threadsInIdentity(userId: string, identityId: string, threadIds: string[]) {
	const ids = Array.from(new Set(threadIds.filter(isUuid)));
	if (!ids.length) return [];
	const rows = await db
		.selectDistinct({ threadId: mailboxThreads.threadId })
		.from(mailboxThreads)
		.where(
			and(
				eq(mailboxThreads.ownerId, userId),
				eq(mailboxThreads.identityId, identityId),
				inArray(mailboxThreads.threadId, ids),
			),
		);
	return rows.map((r) => r.threadId);
}

// Societe connue (crm_companies : deja rattachee a un fil, ou trouvee par search_crm_companies).
export async function knownCompany(companyId: number) {
	const [row] = await db
		.select({ id: crmCompanies.id, name: crmCompanies.name, ebpCustomerId: crmCompanies.ebpCustomerId })
		.from(crmCompanies)
		.where(eq(crmCompanies.id, companyId))
		.limit(1);
	return row ?? null;
}
