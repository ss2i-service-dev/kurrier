import { db, mailboxes, mailboxThreads, messages } from "@db";
import { getServerEnv } from "@schema";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { extension } from "mime-types";
import { s3 } from "../create-s3-client";
import typesense from "../get-typesense";
import {
	type Attachment,
	type MailboxThread,
	type Message,
	McpToolError,
	attachmentsForMessages,
	getOwnedAttachment,
	getOwnedMessage,
	isUuid,
	listIdentities,
	listMailboxes,
	listThreads,
	resolveActionTargets,
	resolveIdentity,
	resolveMailbox,
	searchThreadsSql,
	threadMessages,
	threadPlacements,
	unreadCountsByMailbox,
} from "./access";
import { htmlToText, messageBodyText, truncate } from "@common/html-text";
import { pickSenderIdentity } from "./sender-identity";
import { type QuoteScope, stripQuotedText } from "@common";

// Registry of the mail MCP tools. Each tool receives the authenticated user and arguments
// already validated by its JSON schema (client side); it revalidates what matters and ALWAYS
// goes through the access layer (access.ts) to touch data. Actions (read, star, move, send)
// post the same BullMQ jobs as the web interface (apps/web/lib/actions/mailbox.ts): nothing
// IMAP or SMTP here. To add a tool: one entry in TOOLS, that is all.

export type ToolContext = {
	userId: string;
	email: string;
	authType: "oauth" | "api_key";
	// null = full access (OAuth); otherwise the API key's api_keys.scopes.
	scopes: string[] | null;
};

type JsonSchema = Record<string, unknown>;

// API key scope required per tool: emails:send for everything that sends, emails:receive
// for the rest (reading and filing).
export type ToolScope = "emails:send" | "emails:receive";

export type ToolDefinition = {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	// Fixed, or depending on the arguments (reply/forward as a draft = emails:receive).
	scope: ToolScope | ((args: Record<string, any>) => ToolScope);
	handler: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
};

const JOB_OPTS = {
	attempts: 3,
	backoff: { type: "exponential", delay: 1500 },
	removeOnComplete: true,
	removeOnFail: false,
} as const;

// Deferred import: get-redis opens its connections at module load, which the isolation
// tests (without Redis) should not have to endure.
const redis = () => import("../get-redis").then((m) => m.getRedis());

// ---------------------------------------------------------------------------
// Validation and formatting
// ---------------------------------------------------------------------------

// Simple string: no line breaks (mail headers, folder names, ids), except for bodies
// (multiline).
const str = (
	v: unknown,
	name: string,
	opts?: { optional?: boolean; max?: number; multiline?: boolean },
) => {
	if (v === undefined || v === null || v === "") {
		if (opts?.optional) return undefined;
		throw new McpToolError(`'${name}' is required`);
	}
	if (typeof v !== "string") throw new McpToolError(`'${name}' must be a string`);
	if (opts?.max && v.length > opts.max) throw new McpToolError(`'${name}' is too long`);
	if (!opts?.multiline && /[\r\n]/.test(v)) {
		throw new McpToolError(`'${name}' must not contain line breaks`);
	}
	return v;
};

const int = (v: unknown, name: string, def: number, min: number, max: number) => {
	if (v === undefined || v === null) return def;
	const n = Number(v);
	if (!Number.isInteger(n)) throw new McpToolError(`'${name}' must be an integer`);
	return Math.min(max, Math.max(min, n));
};

const bool = (v: unknown, def: boolean) => (v === undefined || v === null ? def : Boolean(v));

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// An address list: array or comma-separated string; "Name <a@b>" accepted. Checks that
// there is an address in each element.
const emails = (v: unknown, name: string, required = false): string[] => {
	if (v === undefined || v === null || v === "") {
		if (required) throw new McpToolError(`'${name}' is required`);
		return [];
	}
	const raw = Array.isArray(v) ? v.map(String) : String(v).split(",");
	const list = raw.map((s) => s.trim()).filter(Boolean);
	for (const item of list) {
		if (/[\r\n]/.test(item)) throw new McpToolError(`'${name}': line break in address`);
		const addr = item.match(/<([^>]+)>\s*$/)?.[1] ?? item;
		if (!EMAIL_RE.test(addr)) throw new McpToolError(`'${name}': invalid address "${item}"`);
	}
	if (required && !list.length) throw new McpToolError(`'${name}' is required`);
	return list;
};

const threadIdList = (v: unknown) => {
	const list = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
	if (!list.length) throw new McpToolError("'thread_ids' is required");
	if (list.length > 200) throw new McpToolError("'thread_ids': at most 200 threads per call");
	const bad = list.filter((id) => !isUuid(id));
	if (bad.length) throw new McpToolError(`Invalid thread id: ${bad.join(", ")}`);
	return Array.from(new Set(list));
};

type Addr = { name?: string | null; address?: string | null };

const addrList = (obj: any): { name: string; email: string }[] => {
	if (!obj) return [];
	if (typeof obj === "string") return [{ name: "", email: obj }];
	const value: Addr[] = Array.isArray(obj.value) ? obj.value : Array.isArray(obj) ? obj : [];
	return value
		.filter((a) => a && a.address)
		.map((a) => ({ name: String(a.name ?? ""), email: String(a.address) }));
};

const participants = (p: MailboxThread["participants"]) => {
	const map = (list?: { n?: string; e: string }[]) =>
		(list ?? []).map((x) => ({ name: x.n ?? "", email: x.e }));
	return { from: map(p?.from), to: map(p?.to), cc: map(p?.cc) };
};

const threadSummary = (t: MailboxThread) => ({
	thread_id: t.threadId,
	folder: t.mailboxSlug,
	subject: t.subject ?? "",
	preview: t.previewText ?? "",
	participants: participants(t.participants),
	last_activity_at: t.lastActivityAt,
	first_message_at: t.firstMessageAt,
	message_count: t.messageCount,
	unread_count: t.unreadCount,
	unread: t.unreadCount > 0,
	starred: t.starred,
	has_attachments: t.hasAttachments,
});

const attachmentSummary = (a: Attachment) => ({
	attachment_id: a.id,
	message_id: a.messageId,
	filename: a.filenameOriginal,
	content_type: a.contentType,
	size_bytes: a.sizeBytes,
	inline: a.isInline,
});

const messageHeaders = (m: Message, folder: string | null) => ({
	message_id: m.id,
	folder,
	rfc_message_id: m.messageId,
	in_reply_to: m.inReplyTo,
	date: m.date ?? m.createdAt,
	from: addrList(m.from),
	to: addrList(m.to),
	cc: addrList(m.cc),
	reply_to: Array.isArray(m.replyTo) ? m.replyTo : [],
	subject: m.subject ?? "",
	seen: m.seen,
	flagged: m.flagged,
	has_attachments: m.hasAttachments,
});

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Mail body: the interface always sends HTML (rich editor) and the worker adds signature and
// quote to it. Plain text alone would become invisible in the HTML part (signature + quote
// without the body): so both forms are always derived.
const bodyParts = (args: Record<string, any>) => {
	const text = str(args.body_text ?? args.body, "body_text", { optional: true, max: 500_000, multiline: true });
	const html = str(args.body_html, "body_html", { optional: true, max: 2_000_000, multiline: true });
	if (!text && !html) throw new McpToolError("'body_text' or 'body_html' is required");
	return {
		text: text ?? htmlToText(html!),
		html:
			html ??
			text!
				.split(/\n{2,}/)
				.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
				.join(""),
	};
};

// Recipients of a reply (copy of apps/web/lib/reply-recipients.ts, which the worker cannot
// import): "to" = Reply-To, otherwise the sender; "cc" (reply all) = the other recipients,
// without our own addresses.
const replyRecipients = (m: Message, own: string[]) => {
	const ownSet = new Set(own.map((a) => a.toLowerCase()));
	const replyToRaw: Array<{ email?: string }> = Array.isArray(m.replyTo) ? m.replyTo : [];
	const replyTo = replyToRaw.map((r) => r?.email).filter(Boolean) as string[];
	const from = addrList(m.from).map((a) => a.email);
	const to = replyTo.length ? replyTo : from;
	const toSet = new Set(to.map((a) => a.toLowerCase()));
	const cc: string[] = [];
	for (const a of [...addrList(m.to), ...addrList(m.cc)]) {
		const key = a.email.toLowerCase();
		if (ownSet.has(key) || toSet.has(key) || cc.some((c) => c.toLowerCase() === key)) continue;
		cc.push(a.email);
	}
	return { to, cc };
};

// ---------------------------------------------------------------------------
// Sending: same jobs as the interface (send-and-reconcile)
// ---------------------------------------------------------------------------

type UploadedAttachment = {
	path: string;
	bucketId: string;
	messageId: string;
	filenameOriginal: string;
	contentType: string;
	sizeBytes: number;
};

async function uploadAttachments(
	ownerId: string,
	newMessageId: string,
	list: unknown,
): Promise<UploadedAttachment[]> {
	if (!list) return [];
	if (!Array.isArray(list)) throw new McpToolError("'attachments' must be an array");
	if (list.length > 20) throw new McpToolError("At most 20 attachments");
	const { S3_BUCKET } = getServerEnv();
	const out: UploadedAttachment[] = [];
	let total = 0;
	for (const file of list) {
		const filename = str(file?.filename, "attachments[].filename", { max: 255 })!;
		const contentType =
			str(file?.content_type ?? file?.contentType, "attachments[].content_type", { optional: true }) ??
			"application/octet-stream";
		const content = str(file?.content_base64 ?? file?.content, "attachments[].content_base64", { multiline: true })!;
		const buffer = Buffer.from(content, "base64");
		total += buffer.length;
		if (total > 25 * 1024 * 1024) throw new McpToolError("Attachments exceed 25 MB in total");
		const ext = extension(contentType) || filename.split(".").pop() || "dat";
		const path = `private/${ownerId}/${newMessageId}/${crypto.randomUUID()}.${ext}`;
		await s3.send(
			new PutObjectCommand({ Bucket: S3_BUCKET, Key: path, Body: buffer, ContentType: contentType }),
		);
		out.push({
			path,
			bucketId: S3_BUCKET,
			messageId: newMessageId,
			filenameOriginal: filename,
			contentType,
			sizeBytes: buffer.length,
		});
	}
	return out;
}

// Sending identity of a reply or forward (see sender-identity.ts): `identity` parameter if
// given, otherwise the recipient identity of the original message, otherwise that of its
// folder.
async function senderIdentityFor(
	ctx: ToolContext,
	message: Message,
	mailboxIdentityId: string,
	identityArg: unknown,
) {
	const own = await listIdentities(ctx.userId);
	const explicit = identityArg
		? await resolveIdentity(ctx.userId, str(identityArg, "identity"))
		: null;
	type Ident = (typeof own)[number] & { id: string; value: string };
	try {
		return pickSenderIdentity({
			identities: own as Ident[],
			message,
			explicit: explicit as Ident | null,
			mailboxIdentityId,
		}).identity;
	} catch (err: any) {
		throw new McpToolError(err?.message ?? "No sending identity");
	}
}

async function sendViaQueue(opts: {
	ctx: ToolContext;
	identityId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject?: string;
	text: string;
	html: string;
	mode: "new" | "reply" | "forward";
	originalMessageId?: string;
	includeSignature: boolean;
	quoteScope?: QuoteScope;
	attachments: unknown;
	extraAttachments?: UploadedAttachment[];
}) {
	const boxes = await listMailboxes(opts.ctx.userId, opts.identityId);
	const sent = boxes.find((b) => b.kind === "sent");
	const inbox = boxes.find((b) => b.kind === "inbox");
	if (!sent || !inbox) {
		throw new McpToolError("Required folders (inbox and sent) not found for this identity");
	}
	const newMessageId = crypto.randomUUID();
	const uploaded = await uploadAttachments(opts.ctx.userId, newMessageId, opts.attachments);
	const attachments = [...uploaded, ...(opts.extraAttachments ?? [])].map((a) => ({
		...a,
		messageId: newMessageId,
	}));

	// Same payload as the editor form (editor-footer / sendMail), plus apiMessageId to find the
	// sent message and return a reliable result.
	const payload: Record<string, unknown> = {
		identityId: opts.identityId,
		sentMailboxId: sent.id,
		mailboxId: inbox.id,
		senderUserId: opts.ctx.userId,
		to: opts.to,
		cc: opts.cc,
		bcc: opts.bcc,
		subject: opts.subject ?? "",
		text: opts.text,
		html: opts.html,
		mode: opts.mode,
		originalMessageId: opts.originalMessageId,
		includeSignature: opts.includeSignature ? "true" : "false",
		quoteScope: opts.quoteScope,
		newMessageId,
		apiMessageId: newMessageId,
		attachments: JSON.stringify(attachments),
	};

	const { sendMailQueue, sendMailEvents } = await redis();
	const job = await sendMailQueue.add("send-and-reconcile", payload, {
		jobId: `mcp-send-${newMessageId}`,
	});
	try {
		await job.waitUntilFinished(sendMailEvents, 120_000);
	} catch (e: any) {
		throw new McpToolError(`Sending failed: ${e?.message ?? e}`);
	}
	const [sentMessage] = await db
		.select({ id: messages.id, threadId: messages.threadId, subject: messages.subject })
		.from(messages)
		.where(eq(messages.id, newMessageId))
		.limit(1);
	if (!sentMessage) {
		throw new McpToolError("The mail server refused the message (see worker logs)");
	}
	return {
		status: "sent",
		message_id: sentMessage.id,
		thread_id: sentMessage.threadId,
		subject: sentMessage.subject,
		to: opts.to,
		cc: opts.cc,
		bcc: opts.bcc,
		attachments: attachments.length,
	};
}

// ---------------------------------------------------------------------------
// Drafts: service lib/drafts/draft-service.ts (same layer as the web composer, identical
// meta.draft: a draft created here opens in the editor). Deferred import like get-redis
// (the service opens its connections at load).
// ---------------------------------------------------------------------------

const drafts = () => import("../drafts/draft-service");

type DraftSummaryLike = {
	draftMessageId: string;
	threadId: string;
	subject: string | null;
	snippet: string | null;
	to: string[];
	cc: string[];
	bcc: string[];
	mode: string;
	originalMessageId: string | null;
	hasAttachments: boolean;
	updatedAt: Date | null;
	imapSynced: boolean;
};

const draftSummary = (d: DraftSummaryLike) => ({
	draft_id: d.draftMessageId,
	thread_id: d.threadId,
	subject: d.subject ?? "",
	preview: d.snippet ?? "",
	to: d.to,
	cc: d.cc,
	bcc: d.bcc,
	mode: d.mode,
	original_message_id: d.originalMessageId,
	has_attachments: d.hasAttachments,
	updated_at: d.updatedAt,
	imap_synced: d.imapSynced,
});

// A draft of the user: the message -> folder -> identity -> owner chain of access.ts, then
// the draft flag and the Drafts folder.
async function ownedDraft(ctx: ToolContext, draftId: unknown) {
	const id = str(draftId, "draft_id")!;
	let row: Awaited<ReturnType<typeof getOwnedMessage>>;
	try {
		row = await getOwnedMessage(ctx.userId, id);
	} catch {
		throw new McpToolError(`Draft not found: ${id}`);
	}
	if (!row.message.draft || row.mailbox.kind !== "drafts") {
		throw new McpToolError(`Draft not found: ${id}`);
	}
	return row;
}

// Saved by the service (database + delayed IMAP job), then the IMAP version is pushed right
// away: a draft requested through the MCP must show up in Drafts without waiting.
async function saveDraftViaService(opts: {
	ctx: ToolContext;
	identityId: string;
	draftMessageId?: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	text: string;
	html: string;
	mode: "new" | "reply" | "forward";
	originalMessageId?: string;
	includeSignature: boolean;
	quoteScope?: QuoteScope;
	attachments: unknown;
	extraAttachments?: UploadedAttachment[];
}) {
	const service = await drafts();
	const uploadId = opts.draftMessageId ?? crypto.randomUUID();
	const uploaded = await uploadAttachments(opts.ctx.userId, uploadId, opts.attachments);
	const attachments = [...(opts.extraAttachments ?? []), ...uploaded].map((a) => ({
		path: a.path,
		filenameOriginal: a.filenameOriginal,
		contentType: a.contentType,
		sizeBytes: a.sizeBytes,
		messageId: a.messageId || null,
	}));
	let saved: Awaited<ReturnType<typeof service.saveDraft>>;
	try {
		saved = await service.saveDraft({
			ownerId: opts.ctx.userId,
			identityId: opts.identityId,
			draftMessageId: opts.draftMessageId ?? null,
			to: opts.to,
			cc: opts.cc,
			bcc: opts.bcc,
			subject: opts.subject,
			html: opts.html,
			text: opts.text,
			mode: opts.mode,
			originalMessageId: opts.originalMessageId ?? null,
			attachments,
			includeSignature: opts.includeSignature,
			quoteScope: opts.quoteScope,
		});
	} catch (err: any) {
		throw new McpToolError(err?.message ?? "Draft could not be saved");
	}
	await service.flushDraft({ draftMessageId: saved.draftMessageId });
	const detail = await service.getDraft({
		ownerId: opts.ctx.userId,
		identityId: opts.identityId,
		draftMessageId: saved.draftMessageId,
	});
	return {
		status: opts.draftMessageId ? "updated" : "created",
		revision: saved.revision,
		...(detail ? draftSummary(detail) : { draft_id: saved.draftMessageId }),
	};
}

// ---------------------------------------------------------------------------
// Flags and moves: same jobs as markAsRead / toggleStar / moveToFolder
// ---------------------------------------------------------------------------

async function refreshSearch(threadIds: string[]) {
	const { searchIngestQueue } = await redis();
	await Promise.all(
		threadIds.map((threadId) =>
			searchIngestQueue.add("refresh-thread", { threadId }, { ...JOB_OPTS, jobId: `refresh-${threadId}` }),
		),
	);
}

// Read / unread: database updated immediately (like the web), then IMAP flag set by the
// worker if the folder is synced.
async function setSeen(ctx: ToolContext, args: Record<string, any>, seen: boolean) {
	const ids = threadIdList(args.thread_ids);
	const placements = await threadPlacements(ctx.userId, ids);
	const found = new Set(placements.map((p) => p.placement.threadId));
	const missing = ids.filter((id) => !found.has(id));
	if (missing.length) throw new McpToolError(`Thread not found: ${missing.join(", ")}`);
	const folder = str(args.folder, "folder", { optional: true });
	const targets = folder
		? placements.filter((p) => [p.mailbox.id, p.mailbox.slug, p.mailbox.name, p.mailbox.kind].includes(folder))
		: placements;
	const now = new Date();
	const { smtpQueue } = await redis();
	for (const p of targets) {
		const threadId = p.placement.threadId;
		const mailboxId = p.mailbox.id;
		await db.transaction(async (tx) => {
			await tx
				.update(messages)
				.set({ seen, updatedAt: now })
				.where(and(eq(messages.threadId, threadId), eq(messages.mailboxId, mailboxId)));
			const [agg] = await tx
				.select({ unread: sql<number>`count(*) filter (where ${messages.seen} = false)` })
				.from(messages)
				.where(and(eq(messages.threadId, threadId), eq(messages.mailboxId, mailboxId)));
			await tx
				.update(mailboxThreads)
				.set({ unreadCount: seen ? 0 : Number(agg?.unread ?? 1), updatedAt: now })
				.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));
		});
		if (p.sync) {
			await smtpQueue.add(
				"mail:set-flags",
				{ threadId, mailboxId, op: seen ? "read" : "unread" },
				JOB_OPTS,
			);
		}
	}
	await refreshSearch(ids);
	return { status: "ok", threads: ids.length, marked: seen ? "read" : "unread" };
}

async function setStarred(ctx: ToolContext, args: Record<string, any>, starred: boolean) {
	const ids = threadIdList(args.thread_ids);
	const placements = await threadPlacements(ctx.userId, ids);
	const found = new Set(placements.map((p) => p.placement.threadId));
	const missing = ids.filter((id) => !found.has(id));
	if (missing.length) throw new McpToolError(`Thread not found: ${missing.join(", ")}`);
	const { smtpQueue } = await redis();
	for (const p of placements) {
		const threadId = p.placement.threadId;
		const mailboxId = p.mailbox.id;
		if (p.sync) {
			// The worker sets the IMAP flag, then updates the database (imap-flags.ts).
			await smtpQueue.add(
				"mail:set-flags",
				{ threadId, mailboxId, op: starred ? "flag" : "unflag" },
				{ ...JOB_OPTS, removeOnFail: true },
			);
			continue;
		}
		await db.transaction(async (tx) => {
			await tx
				.update(messages)
				.set({ flagged: starred, updatedAt: new Date() })
				.where(and(eq(messages.threadId, threadId), eq(messages.mailboxId, mailboxId)));
			await tx
				.update(mailboxThreads)
				.set({ starred, updatedAt: new Date() })
				.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));
		});
	}
	await refreshSearch(ids);
	return { status: "ok", threads: ids.length, starred };
}

// Wait for the threads to have left the source folder (see waitForThreadsToLeave, web) to
// return a result that reflects the database, with a ceiling.
async function waitForThreadsToLeave(threadIds: string[], mailboxId: string, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [row] = await db
			.select({ n: count() })
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.mailboxId, mailboxId), inArray(mailboxThreads.threadId, threadIds)));
		if (!Number(row?.n ?? 0)) return true;
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

async function moveThreads(
	ctx: ToolContext,
	args: Record<string, any>,
	op: "trash" | "archive" | "move",
) {
	const ids = threadIdList(args.thread_ids);
	const folder = str(args.folder, "folder", { optional: true });
	const groups = await resolveActionTargets({ userId: ctx.userId, threadIds: ids, folder });
	const { smtpQueue, smtpEvents } = await redis();
	const results: Array<Record<string, unknown>> = [];
	for (const g of groups) {
		const src = g.mailbox;
		if (op === "trash" && src.kind === "trash") {
			throw new McpToolError(
				"Threads already in Trash: permanent deletion is not available through this tool",
			);
		}
		if (op === "archive" && src.kind === "archive") {
			results.push({ folder: src.slug, threads: g.threadIds.length, status: "already archived" });
			continue;
		}
		const data: Record<string, unknown> = {
			threadId: g.threadIds[0],
			threadIds: g.threadIds,
			mailboxId: src.id,
			op,
			moveImap: g.imapSynced,
		};
		let jobOpts: Record<string, unknown> = { ...JOB_OPTS };
		if (op === "move") {
			const dest = await resolveMailbox(ctx.userId, src.identityId, str(args.to_folder, "to_folder")!);
			if (dest.id === src.id) throw new McpToolError("Source and destination folders are the same");
			data.toMailboxId = dest.id;
			jobOpts = { ...jobOpts, jobId: `move:${g.threadIds[0]}+${g.threadIds.length - 1}:${src.id}->${dest.id}` };
			results.push({ from: src.slug, to: dest.slug, threads: g.threadIds.length });
		} else if (op === "archive") {
			// Like archiveThread (web): the Archive folder does not always exist, so create it first,
			// on the IMAP side when the mailbox is synced.
			const boxes = await listMailboxes(ctx.userId, src.identityId);
			if (!boxes.some((b) => b.kind === "archive")) {
				if (g.imapSynced) {
					const job = await smtpQueue.add(
						"mailbox:add-new",
						{ name: "Archive", parentId: null, identityId: src.identityId, ownerId: src.ownerId, kind: "archive", slug: "archive" },
						{ attempts: 1, removeOnComplete: true, removeOnFail: true },
					);
					await job.waitUntilFinished(smtpEvents);
				} else {
					await db.insert(mailboxes).values({
						ownerId: src.ownerId,
						workspaceId: src.workspaceId,
						identityId: src.identityId,
						parentId: null,
						kind: "archive",
						name: "Archive",
						slug: "archive",
						isDefault: false,
						metaData: {},
					});
				}
			}
			results.push({ from: src.slug, to: "archive", threads: g.threadIds.length });
		} else {
			results.push({ from: src.slug, to: "trash", threads: g.threadIds.length });
		}
		await smtpQueue.add("mail:move", data, jobOpts);
		await refreshSearch(g.threadIds);
		const done = await waitForThreadsToLeave(g.threadIds, src.id);
		results[results.length - 1].status = done ? "moved" : "queued (still processing)";
	}
	return { status: "ok", results };
}

// ---------------------------------------------------------------------------
// Search: Typesense like the interface (initSearch), SQL fallback
// ---------------------------------------------------------------------------

async function searchThreads(ctx: ToolContext, args: Record<string, any>) {
	const query = str(args.query, "query", { max: 500 })!.trim();
	if (!query) throw new McpToolError("'query' is empty");
	const limit = int(args.limit, "limit", 20, 1, 100);
	const identityRef = str(args.identity, "identity", { optional: true });
	const own = identityRef
		? [await resolveIdentity(ctx.userId, identityRef)]
		: await listIdentities(ctx.userId);
	if (!own.length) return { items: [], total: 0 };
	const folderRef = str(args.folder, "folder", { optional: true });
	let mailboxId: string | null = null;
	let mailboxSlug: string | null = null;
	if (folderRef) {
		if (own.length !== 1) throw new McpToolError("'folder' needs 'identity' when you have several identities");
		const box = await resolveMailbox(ctx.userId, own[0].id, folderRef);
		mailboxId = box.id;
		mailboxSlug = box.slug;
	}

	let hits: Array<{ threadId: string; mailboxId: string }> = [];
	let total = 0;
	let engine = "typesense";
	try {
		const filters = [
			`identityPublicId:=[${own.map((i) => JSON.stringify(i.publicId)).join(",")}]`,
		];
		if (mailboxSlug) filters.push(`mailboxSlug:=${JSON.stringify(mailboxSlug)}`);
		if (bool(args.unread_only, false)) filters.push("unread:=1");
		if (bool(args.has_attachment, false)) filters.push("hasAttachment:=1");
		const result = (await typesense.collections("messages").documents().search({
			q: query,
			// fromDomain is queried too, otherwise a bare domain ("example.com") finds nothing:
			// Typesense strips symbols and indexes "x-y@example.com" as a single word.
			query_by: "subject,snippet,fromName,fromEmail,fromDomain,participants",
			filter_by: filters.join(" && "),
			sort_by: "createdAt:desc",
			group_by: "threadId",
			group_limit: 1,
			per_page: limit,
			page: int(args.page, "page", 1, 1, 100),
		})) as any;
		const groups = result?.grouped_hits as Array<{ hits: Array<{ document: any }> }> | undefined;
		const docs = groups?.length
			? groups.map((g) => g.hits[0]?.document ?? {})
			: (result?.hits ?? []).map((h: any) => h.document ?? {});
		hits = docs
			.filter((d: any) => d.threadId && d.mailboxId)
			.map((d: any) => ({ threadId: String(d.threadId), mailboxId: String(d.mailboxId) }));
		total = Number(result?.found ?? hits.length);
	} catch (err: any) {
		console.error("[mcp] typesense search failed, SQL fallback:", err?.message ?? err);
		engine = "sql";
		const rows = await searchThreadsSql({
			userId: ctx.userId,
			identityIds: own.map((i) => i.id),
			mailboxId,
			query,
			limit,
		});
		return { engine, total: rows.length, items: rows.map(threadSummary) };
	}

	if (!hits.length) return { engine, total, items: [] };
	// Double check: only the user's mailbox_threads rows come out.
	const rows = await db
		.select()
		.from(mailboxThreads)
		.where(
			and(
				eq(mailboxThreads.ownerId, ctx.userId),
				inArray(mailboxThreads.threadId, hits.map((h) => h.threadId)),
			),
		);
	const byKey = new Map(rows.map((r) => [`${r.threadId}:${r.mailboxId}`, r]));
	const byThread = new Map<string, MailboxThread>();
	for (const r of rows) if (!byThread.has(r.threadId)) byThread.set(r.threadId, r);
	const items = hits
		.map((h) => byKey.get(`${h.threadId}:${h.mailboxId}`) ?? byThread.get(h.threadId))
		.filter(Boolean)
		.map((r) => threadSummary(r!));
	return { engine, total, items };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const identityProp = {
	type: "string",
	description: "Identity (email address, id or public id). Optional when you have a single identity.",
};
const folderProp = {
	type: "string",
	description: "Folder slug, name, kind or id (inbox, sent, archive, spam, trash, or a custom folder).",
};
const threadIdsProp = {
	type: "array",
	items: { type: "string" },
	minItems: 1,
	maxItems: 200,
	description: "Thread ids (from list_threads, search or get_thread).",
};
const asDraftProp = {
	type: "boolean",
	description: "Save as a draft (reviewable in the web editor) instead of sending. Default false.",
};
const bodyProps = {
	body_text: { type: "string", description: "Plain-text body. Paragraphs separated by blank lines." },
	body_html: { type: "string", description: "HTML body (optional; derived from body_text when absent)." },
	include_signature: {
		type: "boolean",
		description: "Append the identity signature, as the web editor does (default true).",
	},
	attachments: {
		type: "array",
		description: "Files to attach, base64-encoded (25 MB in total at most).",
		items: {
			type: "object",
			properties: {
				filename: { type: "string" },
				content_type: { type: "string" },
				content_base64: { type: "string" },
			},
			required: ["filename", "content_base64"],
			additionalProperties: false,
		},
	},
};

export const TOOLS: ToolDefinition[] = [
	{
		name: "whoami",
		scope: "emails:receive",
		description: "Who is authenticated: user id, email, authentication type and email identities.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: async (ctx) => {
			const own = await listIdentities(ctx.userId);
			return {
				user_id: ctx.userId,
				email: ctx.email,
				auth_type: ctx.authType,
				identities: own.map((i) => ({ id: i.id, public_id: i.publicId, email: i.value })),
			};
		},
	},
	{
		name: "list_identities",
		scope: "emails:receive",
		description: "List the email identities (accounts) of the authenticated user.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: async (ctx) => {
			const own = await listIdentities(ctx.userId);
			return {
				identities: own.map((i) => ({
					id: i.id,
					public_id: i.publicId,
					email: i.value,
					display_name: i.displayName,
					status: i.status,
					has_signature: Boolean(String((i.metaData as any)?.signatureHtml ?? "").trim()),
				})),
			};
		},
	},
	{
		name: "list_folders",
		scope: "emails:receive",
		description: "List the folders of an identity with thread and unread counts.",
		inputSchema: {
			type: "object",
			properties: { identity: identityProp },
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const identity = await resolveIdentity(ctx.userId, str(args.identity, "identity", { optional: true }));
			const [boxes, counts] = await Promise.all([
				listMailboxes(ctx.userId, identity.id),
				unreadCountsByMailbox(ctx.userId, identity.id),
			]);
			return {
				identity: identity.value,
				folders: boxes
					.filter((b) => !["outbox", "drafts"].includes(b.kind))
					.map((b) => ({
						id: b.id,
						slug: b.slug,
						name: b.name,
						kind: b.kind,
						parent_id: b.parentId,
						imap_synced: b.imapSynced,
						threads: counts.get(b.id)?.threads ?? 0,
						unread_threads: counts.get(b.id)?.unreadThreads ?? 0,
						unread_messages: counts.get(b.id)?.unreadTotal ?? 0,
					})),
			};
		},
	},
	{
		name: "list_threads",
		scope: "emails:receive",
		description:
			"List threads of a folder, most recent activity first: subject, participants, preview, date, unread, starred, attachments. Paginate with offset.",
		inputSchema: {
			type: "object",
			properties: {
				identity: identityProp,
				folder: { ...folderProp, description: `${folderProp.description} Default inbox.` },
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
				offset: { type: "integer", minimum: 0, description: "Default 0." },
				unread_only: { type: "boolean" },
				starred_only: { type: "boolean" },
			},
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const identity = await resolveIdentity(ctx.userId, str(args.identity, "identity", { optional: true }));
			const box = await resolveMailbox(ctx.userId, identity.id, str(args.folder, "folder", { optional: true }) ?? "inbox");
			const limit = int(args.limit, "limit", 25, 1, 100);
			const offset = int(args.offset, "offset", 0, 0, 1_000_000);
			const rows = await listThreads({
				userId: ctx.userId,
				mailboxId: box.id,
				limit,
				offset,
				unreadOnly: bool(args.unread_only, false),
				starredOnly: bool(args.starred_only, false),
			});
			const hasMore = rows.length > limit;
			return {
				identity: identity.value,
				folder: box.slug,
				offset,
				has_more: hasMore,
				next_offset: hasMore ? offset + limit : null,
				items: rows.slice(0, limit).map(threadSummary),
			};
		},
	},
	{
		name: "search",
		scope: "emails:receive",
		description:
			"Full-text search across threads (subject, preview, sender, participants), same engine as the web search. Optional identity and folder filters.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1 },
				identity: identityProp,
				folder: folderProp,
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
				page: { type: "integer", minimum: 1 },
				unread_only: { type: "boolean" },
				has_attachment: { type: "boolean" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		handler: searchThreads,
	},
	{
		name: "get_thread",
		scope: "emails:receive",
		description:
			"Read a thread: every message as readable text with from/to/cc/date headers, message ids and attachments. Does not mark it read unless mark_read is true.",
		inputSchema: {
			type: "object",
			properties: {
				thread_id: { type: "string" },
				strip_quotes: {
					type: "boolean",
					description: "Drop quoted previous messages from each body (default false).",
				},
				max_chars_per_message: { type: "integer", minimum: 200, maximum: 200000, description: "Default 20000." },
				mark_read: { type: "boolean", description: "Mark the thread read after reading (default false)." },
			},
			required: ["thread_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const threadId = str(args.thread_id, "thread_id")!;
			const rows = await threadMessages(ctx.userId, threadId);
			const attachments = await attachmentsForMessages(ctx.userId, rows.map((r) => r.message.id));
			const byMessage = new Map<string, Attachment[]>();
			for (const a of attachments) {
				const list = byMessage.get(a.messageId) ?? [];
				list.push(a);
				byMessage.set(a.messageId, list);
			}
			const max = int(args.max_chars_per_message, "max_chars_per_message", 20_000, 200, 200_000);
			const strip = bool(args.strip_quotes, false);
			const items = rows.map(({ message, mailbox }) => {
				let body = messageBodyText(message);
				if (strip) body = stripQuotedText(body);
				const t = truncate(body, max);
				return {
					...messageHeaders(message, mailbox.slug),
					body: t.text,
					body_truncated: t.truncated,
					attachments: (byMessage.get(message.id) ?? []).map(attachmentSummary),
				};
			});
			let marked = false;
			if (bool(args.mark_read, false)) {
				await setSeen(ctx, { thread_ids: [threadId] }, true);
				marked = true;
			}
			return {
				thread_id: threadId,
				subject: rows[rows.length - 1].message.subject ?? rows[0].message.subject ?? "",
				message_count: items.length,
				marked_read: marked,
				messages: items,
			};
		},
	},
	{
		name: "get_attachment",
		scope: "emails:receive",
		description:
			"Fetch an attachment: text content for text-like files (txt, csv, json, xml, html, ics, eml), otherwise a short-lived signed download URL (5 minutes).",
		inputSchema: {
			type: "object",
			properties: {
				attachment_id: { type: "string" },
				max_chars: { type: "integer", minimum: 1000, maximum: 500000, description: "Default 100000." },
				force_url: { type: "boolean", description: "Always return a signed URL instead of text." },
			},
			required: ["attachment_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const att = await getOwnedAttachment(ctx.userId, str(args.attachment_id, "attachment_id")!);
			const { S3_BUCKET } = getServerEnv();
			// Always S3_BUCKET, like the web (mailbox.ts) and sending (send-mail.ts): bucket_id is
			// "attachments" (still Supabase) on incoming attachments, a bucket that does not exist.
			const bucket = S3_BUCKET;
			const contentType = String(att.contentType ?? "application/octet-stream").toLowerCase();
			const textLike =
				/^text\//.test(contentType) ||
				/(json|xml|csv|calendar|rfc822|javascript|x-sh)/.test(contentType);
			const sizeOk = Number(att.sizeBytes ?? 0) <= 5 * 1024 * 1024;
			if (textLike && sizeOk && !bool(args.force_url, false)) {
				const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: att.path }));
				const raw = await res.Body?.transformToString("utf-8");
				const content = contentType.includes("html") ? htmlToText(raw ?? "") : (raw ?? "");
				const t = truncate(content, int(args.max_chars, "max_chars", 100_000, 1000, 500_000));
				return { ...attachmentSummary(att), kind: "text", content: t.text, truncated: t.truncated };
			}
			const url = await getSignedUrl(
				s3,
				new GetObjectCommand({
					Bucket: bucket,
					Key: att.path,
					ResponseContentDisposition: `attachment; filename="${encodeURIComponent(att.filenameOriginal ?? "attachment")}"`,
				}),
				{ expiresIn: 300 },
			);
			return { ...attachmentSummary(att), kind: "url", url, expires_in_seconds: 300 };
		},
	},
	{
		name: "send_email",
		scope: "emails:send",
		description:
			"Send a new email from one of your identities. Goes through the same sending pipeline as the web app (signature, Sent folder, contacts). Confirm with the user before sending.",
		inputSchema: {
			type: "object",
			properties: {
				identity: identityProp,
				to: { type: "array", items: { type: "string" }, minItems: 1, description: "Recipients." },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string" },
				...bodyProps,
			},
			required: ["to", "subject"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const identity = await resolveIdentity(ctx.userId, str(args.identity, "identity", { optional: true }));
			const { text, html } = bodyParts(args);
			return sendViaQueue({
				ctx,
				identityId: identity.id,
				to: emails(args.to, "to", true),
				cc: emails(args.cc, "cc"),
				bcc: emails(args.bcc, "bcc"),
				subject: str(args.subject, "subject", { max: 998 }),
				text,
				html,
				mode: "new",
				includeSignature: bool(args.include_signature, true),
				attachments: args.attachments,
			});
		},
	},
	{
		name: "reply",
		scope: (args) => (args.as_draft ? "emails:receive" : "emails:send"),
		description:
			"Reply to a message (by message_id from get_thread). Recipients, subject (Re:), quoting, In-Reply-To and References are computed like the web editor. quote chooses what is quoted: 'last' (default) quotes only the message replied to, without the history it quotes itself; 'thread' quotes it whole. Where the body goes depends on the user's composing setting: above the quote by default, or below it with the '-- ' signature separator when the user enabled the RFC style. reply_all adds the other recipients in cc. With as_draft, saves a draft attached to the thread for the user to review in the web editor instead of sending.",
		inputSchema: {
			type: "object",
			properties: {
				message_id: { type: "string" },
				reply_all: { type: "boolean", description: "Default false." },
				to: { type: "array", items: { type: "string" }, description: "Override the computed recipients." },
				cc: { type: "array", items: { type: "string" }, description: "Extra cc recipients." },
				bcc: { type: "array", items: { type: "string" } },
				identity: {
					...identityProp,
					description:
						"Identity to send from (email address, id or public id). Default: the identity that received the message (To, Cc, Delivered-To), else the identity of its folder.",
				},
				quote: {
					type: "string",
					enum: ["last", "thread"],
					description: "What to quote: 'last' (default) the message only, 'thread' the message with the history it quotes.",
				},
				as_draft: asDraftProp,
				...bodyProps,
			},
			required: ["message_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const { message, identity: mailboxIdentity } = await getOwnedMessage(ctx.userId, str(args.message_id, "message_id")!);
			const identity = await senderIdentityFor(ctx, message, mailboxIdentity.id, args.identity);
			const own = (await listIdentities(ctx.userId)).map((i) => i.value);
			const computed = replyRecipients(message, own);
			const to = args.to ? emails(args.to, "to", true) : computed.to;
			if (!to.length) throw new McpToolError("No recipient could be derived; pass 'to'");
			const cc = [
				...(bool(args.reply_all, false) ? computed.cc : []),
				...emails(args.cc, "cc"),
			];
			const { text, html } = bodyParts(args);
			const outgoing = {
				ctx,
				identityId: identity.id,
				to,
				cc: Array.from(new Set(cc)),
				bcc: emails(args.bcc, "bcc"),
				subject: message.subject ?? "",
				text,
				html,
				mode: "reply" as const,
				originalMessageId: message.id,
				includeSignature: bool(args.include_signature, true),
				quoteScope: args.quote === "thread" ? ("thread" as const) : ("last" as const),
				attachments: args.attachments,
			};
			if (bool(args.as_draft, false)) return saveDraftViaService(outgoing);
			return sendViaQueue(outgoing);
		},
	},
	{
		name: "forward",
		scope: (args) => (args.as_draft ? "emails:receive" : "emails:send"),
		description:
			"Forward a message (by message_id from get_thread) to new recipients, with its original attachments unless include_attachments is false. Subject (Fwd:) and quoting are computed like the web editor. With as_draft, saves a draft for the user to review in the web editor instead of sending (to may then be empty).",
		inputSchema: {
			type: "object",
			properties: {
				message_id: { type: "string" },
				to: { type: "array", items: { type: "string" }, minItems: 1 },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				include_attachments: { type: "boolean", description: "Default true." },
				identity: {
					...identityProp,
					description:
						"Identity to send from (email address, id or public id). Default: the identity that received the message (To, Cc, Delivered-To), else the identity of its folder.",
				},
				as_draft: asDraftProp,
				...bodyProps,
			},
			required: ["message_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const { message, identity: mailboxIdentity } = await getOwnedMessage(ctx.userId, str(args.message_id, "message_id")!);
			const identity = await senderIdentityFor(ctx, message, mailboxIdentity.id, args.identity);
			const bodyGiven = args.body_text || args.body || args.body_html;
			const { text, html } = bodyGiven ? bodyParts(args) : { text: "", html: "" };
			const original = bool(args.include_attachments, true)
				? (await attachmentsForMessages(ctx.userId, [message.id]))
						.filter((a) => !a.isInline)
						.map((a) => ({
							path: a.path,
							bucketId: a.bucketId,
							messageId: "",
							filenameOriginal: a.filenameOriginal ?? "attachment",
							contentType: a.contentType ?? "application/octet-stream",
							sizeBytes: Number(a.sizeBytes ?? 0),
						}))
				: [];
			const outgoing = {
				ctx,
				identityId: identity.id,
				// As a draft, the recipients can come later (review in the web editor).
				to: emails(args.to, "to", !bool(args.as_draft, false)),
				cc: emails(args.cc, "cc"),
				bcc: emails(args.bcc, "bcc"),
				subject: message.subject ?? "",
				text,
				html,
				mode: "forward" as const,
				originalMessageId: message.id,
				includeSignature: bool(args.include_signature, true),
				attachments: args.attachments,
				extraAttachments: original,
			};
			if (bool(args.as_draft, false)) return saveDraftViaService(outgoing);
			return sendViaQueue(outgoing);
		},
	},
	{
		name: "list_drafts",
		scope: "emails:receive",
		description: "List the drafts of an identity (Drafts folder), most recently saved first.",
		inputSchema: {
			type: "object",
			properties: {
				identity: identityProp,
				limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
				offset: { type: "integer", minimum: 0 },
			},
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const identity = await resolveIdentity(ctx.userId, str(args.identity, "identity", { optional: true }));
			const service = await drafts();
			const list = await service.listDrafts({
				ownerId: ctx.userId,
				identityId: identity.id,
				limit: int(args.limit, "limit", 50, 1, 200),
				offset: int(args.offset, "offset", 0, 0, 1_000_000),
			});
			return { identity: identity.value, drafts: list.map(draftSummary) };
		},
	},
	{
		name: "get_draft",
		scope: "emails:receive",
		description: "Read a draft: recipients, subject, body as text (and HTML), attachments, reply/forward context.",
		inputSchema: {
			type: "object",
			properties: { draft_id: { type: "string", description: "Draft id from list_drafts, create_draft, reply or forward with as_draft." } },
			required: ["draft_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const { identity, message } = await ownedDraft(ctx, args.draft_id);
			const detail = await (await drafts()).getDraft({ ownerId: ctx.userId, identityId: identity.id, draftMessageId: message.id });
			if (!detail) throw new McpToolError(`Draft not found: ${message.id}`);
			return {
				...draftSummary(detail),
				body_text: detail.text || htmlToText(detail.html),
				body_html: detail.html,
				include_signature: detail.includeSignature,
				quote: detail.quoteScope ?? "thread",
				attachments: detail.attachments.map((a) => ({
					filename: a.filenameOriginal,
					content_type: a.contentType,
					size_bytes: a.sizeBytes,
				})),
			};
		},
	},
	{
		name: "create_draft",
		scope: "emails:receive",
		description:
			"Create a new draft in the Drafts folder of an identity. The user can open and finish it in the web editor. Nothing is sent.",
		inputSchema: {
			type: "object",
			properties: {
				identity: identityProp,
				to: { type: "array", items: { type: "string" } },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string" },
				...bodyProps,
			},
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const identity = await resolveIdentity(ctx.userId, str(args.identity, "identity", { optional: true }));
			const bodyGiven = args.body_text || args.body || args.body_html;
			const { text, html } = bodyGiven ? bodyParts(args) : { text: "", html: "" };
			return saveDraftViaService({
				ctx,
				identityId: identity.id,
				to: emails(args.to, "to"),
				cc: emails(args.cc, "cc"),
				bcc: emails(args.bcc, "bcc"),
				subject: str(args.subject, "subject", { optional: true, max: 998 }) ?? "",
				text,
				html,
				mode: "new",
				includeSignature: bool(args.include_signature, true),
				attachments: args.attachments,
			});
		},
	},
	{
		name: "update_draft",
		scope: "emails:receive",
		description:
			"Update a draft: only the fields passed change (to, cc, bcc, subject, body, include_signature); new attachments are added to the existing ones.",
		inputSchema: {
			type: "object",
			properties: {
				draft_id: { type: "string" },
				to: { type: "array", items: { type: "string" } },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string" },
				...bodyProps,
			},
			required: ["draft_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const { identity, message } = await ownedDraft(ctx, args.draft_id);
			const service = await drafts();
			const current = await service.getDraft({ ownerId: ctx.userId, identityId: identity.id, draftMessageId: message.id });
			if (!current) throw new McpToolError(`Draft not found: ${message.id}`);
			const bodyGiven = args.body_text || args.body || args.body_html;
			const body = bodyGiven ? bodyParts(args) : { text: current.text, html: current.html };
			return saveDraftViaService({
				ctx,
				identityId: identity.id,
				draftMessageId: message.id,
				to: args.to === undefined ? current.to : emails(args.to, "to"),
				cc: args.cc === undefined ? current.cc : emails(args.cc, "cc"),
				bcc: args.bcc === undefined ? current.bcc : emails(args.bcc, "bcc"),
				subject: args.subject === undefined ? (current.subject ?? "") : (str(args.subject, "subject", { optional: true, max: 998 }) ?? ""),
				text: body.text,
				html: body.html,
				mode: current.mode === "reply" || current.mode === "forward" ? current.mode : "new",
				originalMessageId: current.originalMessageId ?? undefined,
				includeSignature: args.include_signature === undefined ? current.includeSignature : bool(args.include_signature, true),
				quoteScope: current.quoteScope ?? undefined,
				attachments: args.attachments,
				extraAttachments: current.attachments.map((a) => ({
					path: a.path,
					bucketId: "",
					messageId: a.messageId ?? "",
					filenameOriginal: a.filenameOriginal ?? "attachment",
					contentType: a.contentType ?? "application/octet-stream",
					sizeBytes: Number(a.sizeBytes ?? 0),
				})),
			});
		},
	},
	{
		name: "delete_draft",
		scope: "emails:receive",
		description: "Delete a draft (drafts are removed for good, as mail clients do; this never touches real messages).",
		inputSchema: {
			type: "object",
			properties: { draft_id: { type: "string" } },
			required: ["draft_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const { identity, message } = await ownedDraft(ctx, args.draft_id);
			const result = await (await drafts()).deleteDraft({ ownerId: ctx.userId, identityId: identity.id, draftMessageId: message.id });
			if (!result.deleted) throw new McpToolError(`Draft not found: ${message.id}`);
			return { status: "deleted", draft_id: message.id };
		},
	},
	{
		name: "send_draft",
		scope: "emails:send",
		description:
			"Send a draft through the regular pipeline, with the same 30-second undo delay as the web editor (the send can still be cancelled from the web app during that delay). Confirm with the user first.",
		inputSchema: {
			type: "object",
			properties: { draft_id: { type: "string" } },
			required: ["draft_id"],
			additionalProperties: false,
		},
		handler: async (ctx, args) => {
			const { identity, message } = await ownedDraft(ctx, args.draft_id);
			let result: { pendingSendId: string; undoMs: number };
			try {
				result = await (await drafts()).sendDraft({
					ownerId: ctx.userId,
					identityId: identity.id,
					draftMessageId: message.id,
					senderUserId: ctx.userId,
				});
			} catch (err: any) {
				throw new McpToolError(err?.message ?? "Draft could not be sent");
			}
			return {
				status: "scheduled",
				draft_id: message.id,
				pending_send_id: result.pendingSendId,
				sends_in_ms: result.undoMs,
				note: "The message leaves after the undo delay; the draft is removed once sent.",
			};
		},
	},
	{
		name: "mark_read",
		scope: "emails:receive",
		description: "Mark threads as read (in every folder they appear in, or only in 'folder').",
		inputSchema: {
			type: "object",
			properties: { thread_ids: threadIdsProp, folder: folderProp },
			required: ["thread_ids"],
			additionalProperties: false,
		},
		handler: (ctx, args) => setSeen(ctx, args, true),
	},
	{
		name: "mark_unread",
		scope: "emails:receive",
		description: "Mark threads as unread (in every folder they appear in, or only in 'folder').",
		inputSchema: {
			type: "object",
			properties: { thread_ids: threadIdsProp, folder: folderProp },
			required: ["thread_ids"],
			additionalProperties: false,
		},
		handler: (ctx, args) => setSeen(ctx, args, false),
	},
	{
		name: "star",
		scope: "emails:receive",
		description: "Star (flag) threads.",
		inputSchema: {
			type: "object",
			properties: { thread_ids: threadIdsProp },
			required: ["thread_ids"],
			additionalProperties: false,
		},
		handler: (ctx, args) => setStarred(ctx, args, true),
	},
	{
		name: "unstar",
		scope: "emails:receive",
		description: "Remove the star (flag) from threads.",
		inputSchema: {
			type: "object",
			properties: { thread_ids: threadIdsProp },
			required: ["thread_ids"],
			additionalProperties: false,
		},
		handler: (ctx, args) => setStarred(ctx, args, false),
	},
	{
		name: "move_to_folder",
		scope: "emails:receive",
		description:
			"Move threads to another folder of the same identity. 'folder' (source) is only needed when a thread sits in several folders.",
		inputSchema: {
			type: "object",
			properties: {
				thread_ids: threadIdsProp,
				to_folder: { ...folderProp, description: "Destination folder (slug, name, kind or id)." },
				folder: { ...folderProp, description: "Source folder, when ambiguous." },
			},
			required: ["thread_ids", "to_folder"],
			additionalProperties: false,
		},
		handler: (ctx, args) => moveThreads(ctx, args, "move"),
	},
	{
		name: "archive",
		scope: "emails:receive",
		description: "Archive threads (move them to the Archive folder, created if needed).",
		inputSchema: {
			type: "object",
			properties: { thread_ids: threadIdsProp, folder: { ...folderProp, description: "Source folder, when ambiguous." } },
			required: ["thread_ids"],
			additionalProperties: false,
		},
		handler: (ctx, args) => moveThreads(ctx, args, "archive"),
	},
	{
		name: "trash",
		scope: "emails:receive",
		description:
			"Move threads to Trash. Never deletes permanently: threads already in Trash are refused.",
		inputSchema: {
			type: "object",
			properties: { thread_ids: threadIdsProp, folder: { ...folderProp, description: "Source folder, when ambiguous." } },
			required: ["thread_ids"],
			additionalProperties: false,
		},
		handler: (ctx, args) => moveThreads(ctx, args, "trash"),
	},
];

export function findTool(name: string) {
	return TOOLS.find((t) => t.name === name) ?? null;
}
