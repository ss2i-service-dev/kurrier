import { simpleParser, ParsedMail, Attachment } from "mailparser";
import {
	db,
	messages,
	messageAttachments,
	threads,
	MessageInsertSchema,
	MessageCreate,
	MessageAttachmentCreate,
	MessageAttachmentInsertSchema,
	workspaces,
} from "@db";
import { generateSnippet, upsertMailboxThreadItem } from "@common";
import { randomUUID } from "crypto";
import { and, desc, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { lockOwnerThreads, mergeLinkedThreads } from "./thread-links";
import { getRedis } from "../lib/get-redis";
import {s3} from "../lib/create-s3-client";
import {PutObjectCommand} from "@aws-sdk/client-s3";
import { upsertMailSubscription } from "./mail-subscriptions";
import {upsertWorkspaceSharedContactFromMessage} from "../lib/message-parser-contacts";

const SEARCH_BATCH_SIZE = 100;
const WEBHOOK_BATCH_SIZE = 100;
const RULES_BATCH_SIZE = 100;
const CALENDAR_BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;

type SearchJob = {
	messageId: string;
	contactId: string | null;
	ownerId?: string;
};
type WebhookJob = { message: any; rawEmail: string };
type ICSJob = {
	messageId: string;
	messageAttachmentId: string;
	mailboxId: string;
};
type RulesJob = {
	messageId: string;
};
let searchBuffer: SearchJob[] = [];
let webhookBuffer: WebhookJob[] = [];
let icsBuffer: ICSJob[] = [];
let rulesBuffer: RulesJob[] = [];
let flushTimer: any = null;

async function flushBatches() {
	if (!searchBuffer.length && !webhookBuffer.length && !icsBuffer.length && !rulesBuffer.length)
		return;

	try {
		const { searchIngestQueue, commonWorkerQueue, davWorkerQueue } =
			await getRedis();

		if (searchBuffer.length) {
			const messageIds = searchBuffer.map((job) => job.messageId);
			// Only messages attached to an existing contact push it to CardDAV.
			const contactIds = searchBuffer
				.map((job) => job.contactId)
				.filter((id) => id && id !== "null");
			const ownerId = searchBuffer[0].ownerId;

			await searchIngestQueue.add(
				"addBatch",
				{ messageIds },
				{ removeOnComplete: true },
			);
			if (contactIds.length) {
				await davWorkerQueue.add(
					"dav:create-contacts-batch",
					{ contactIds: contactIds, ownerId },
					{ removeOnComplete: true, removeOnFail: true },
				);
			}

			searchBuffer = [];
		}

		if (icsBuffer.length) {
			await davWorkerQueue.add(
				"dav:calendar:itip-ingest-batch",
				{
					items: icsBuffer.map((job) => ({
						messageId: job.messageId,
						messageAttachmentId: job.messageAttachmentId,
						mailboxId: job.mailboxId,
					})),
				},
				{
					removeOnComplete: true,
					removeOnFail: true,
				},
			);

			icsBuffer = [];
		}

		if (webhookBuffer.length) {
			const jobs = webhookBuffer.map((job) => ({
				name: "webhook:message.received",
				data: {
					message: job.message,
					rawEmail: job.rawEmail,
				},
			}));

			await commonWorkerQueue.addBulk(jobs);
			webhookBuffer = [];
		}

		if (rulesBuffer.length) {
			const jobs = rulesBuffer.map((job) => ({
				name: "rules:processor",
				data: {
					messageId: job.messageId
				},
			}));
			await commonWorkerQueue.addBulk(jobs);
			rulesBuffer = [];
		}
	} catch (err: any) {
		console.error(
			"[parseAndStoreEmail] Error flushing batches:",
			err?.message ?? err,
		);
	}
}

function scheduleFlush() {
	if (flushTimer) return;
	flushTimer = setTimeout(async () => {
		flushTimer = null;
		await flushBatches();
	}, FLUSH_INTERVAL_MS);
}

function generateFileName(att: Attachment) {
	const ext =
		att.filename?.split(".").pop()?.toLowerCase() ||
		att.contentType?.split("/")[1]?.split("+")[0] ||
		"bin";
	return `${randomUUID()}.${ext}`;
}

export function parentCandidates(parsed: ParsedMail) {
	const inReplyTo = parsed.inReplyTo?.trim() || null;
	const refs = Array.isArray(parsed.references)
		? parsed.references
		: parsed.references
			? [parsed.references]
			: [];
	const candidates = Array.from(
		new Set([inReplyTo, ...refs].filter(Boolean).map((s) => String(s))),
	);
	return { inReplyTo, candidates };
}

// Threads: `outerTx` lets parseAndStoreEmail choose the thread, insert the message and
// group the linked threads in a single transaction, under the owner's lock.
export async function createOrInitializeThread(
	parsed: ParsedMail & { ownerId: string, workspaceId: string },
	outerTx?: any,
) {
	const { ownerId, workspaceId } = parsed;
	const { inReplyTo, candidates } = parentCandidates(parsed);

	const run = async (tx: any) => {
		let existingThread = null;

		if (candidates.length > 0) {
			const parentMsgs = await tx
				.select({
					id: messages.id,
					threadId: messages.threadId,
					messageId: messages.messageId,
					date: messages.date,
				})
				.from(messages)
				.where(
					and(
						eq(messages.ownerId, ownerId),
						inArray(messages.messageId, candidates),
					),
				)
				.orderBy(desc(messages.date ?? sql`now()`));

			if (parentMsgs.length) {
				const chosen = inReplyTo
					? parentMsgs.find((m: any) => m.messageId === inReplyTo)
					: parentMsgs[0];

				if (chosen?.threadId) {
					const [t] = await tx
						.select()
						.from(threads)
						.where(eq(threads.id, chosen.threadId));
					if (t) existingThread = t;
				}
			}
		}

		if (existingThread) return { ...existingThread, foundParent: true };

		const [newThread] = await tx
			.insert(threads)
			.values({
				ownerId,
				workspaceId,
				lastMessageDate: parsed.date ?? new Date(),
			})
			.returning();

		return { ...newThread, foundParent: false };
	};

	return outerTx ? run(outerTx) : db.transaction(run);
}

function getFromAddress(parsed: ParsedMail) {
	const from = parsed.from?.value?.[0];
	if (!from?.address) return null;
	return {
		email: from.address.trim().toLowerCase(),
		name: (from.name || "").trim() || null,
	};
}


function isIcsAttachment(att: Attachment) {
	const ct = (att.contentType || "").toLowerCase();
	const name = (att.filename || "").toLowerCase();

	return (
		ct.startsWith("text/calendar") ||
		ct === "application/ics" ||
		name.endsWith(".ics")
	);
}

/**
 * Parse raw email, create thread, insert message + attachments.
 */
// PostgreSQL refuses the null byte in a text as well as in a jsonb (error 22021,
// "invalid byte sequence for encoding UTF8: 0x00"). A single message containing one, mostly
// spam, would fail its insert, and with it the whole account sync or the backfill window in
// progress. These bytes are stripped before inserting.
function stripNul<T>(value: T): T {
	if (typeof value === "string") return value.replace(/\u0000/g, "") as T;
	if (Array.isArray(value)) return value.map(stripNul) as T;
	if (
		value &&
		typeof value === "object" &&
		!(value instanceof Date) &&
		!Buffer.isBuffer(value)
	) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = stripNul(v);
		return out as T;
	}
	return value;
}

/**
 * Threads: thread choice, message insert, grouping of linked threads (lib/thread-links.ts)
 * and mailbox_threads row in a single transaction, under the owner's lock. A message already
 * present (same folder, same Message-ID) cancels everything and returns null: no empty thread
 * created for nothing.
 */
export async function storeMessageInThread(
	parsed: ParsedMail,
	decoratedParsed: Record<string, any>,
	opts: { ownerId: string; workspaceId: string },
): Promise<{ message: typeof messages.$inferSelect; threadId: string; merged: boolean } | null> {
	const { ownerId, workspaceId } = opts;
	try {
		return await db.transaction(async (tx) => {
			await lockOwnerThreads(tx, ownerId);
			const thread = await createOrInitializeThread({ ...parsed, ownerId, workspaceId }, tx);
			const messagePayload = stripNul(
				MessageInsertSchema.parse({ ...decoratedParsed, threadId: thread.id }),
			);
			const [inserted] = await tx
				.insert(messages)
				.values(messagePayload as MessageCreate)
				.onConflictDoNothing({
					target: [messages.mailboxId, messages.messageId],
				})
				.returning();
			if (!inserted) tx.rollback();
			const linked = await mergeLinkedThreads(tx, {
				ownerId,
				messageId: inserted.messageId,
				candidates: parentCandidates(parsed).candidates,
				threadId: thread.id,
				foundParent: thread.foundParent,
			});
			// List row written under the same lock: outside the transaction, it would collide with a
			// concurrent merge of the same thread (deadlock seen in a parallel test).
			await upsertMailboxThreadItem(inserted.id, tx);
			return {
				message: { ...inserted, threadId: linked.threadId },
				threadId: linked.threadId,
				merged: linked.merged,
			};
		});
	} catch (err) {
		if (err instanceof TransactionRollbackError) return null;
		throw err;
	}
}

export async function parseAndStoreEmail(
	rawEmail: string,
	opts: {
		ownerId: string;
		workspaceId: string;
		mailboxId: string;
		rawStorageKey: string;
		emlKey: string;
		metaData?: Record<string, any>;
		seen?: boolean;
		answered?: boolean;
		flagged?: boolean;
		mode?: "live" | "backfill";
	},
) {
	const { ownerId, workspaceId, mailboxId, rawStorageKey } = opts;
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
	if (workspace?.isStorageOverLimit) {
		return
	}

	const mode = opts.mode ?? "live";

	const parsed = await simpleParser(rawEmail);
	const headers = parsed.headers as Map<string, any>;

	const encoder = new TextEncoder();
	const emailBuffer = encoder.encode(rawEmail);
	const sizeBytes = emailBuffer.byteLength;

	await s3.send(new PutObjectCommand({
		Bucket: process.env.S3_BUCKET!,
		Key: opts.rawStorageKey,
		Body: emailBuffer,
		ContentType: "message/rfc822",
	}));

	const messageId =
		parsed.messageId || String(headers.get("message-id") || "").trim();

	if (!messageId) {
		console.warn(
			`[parseAndStoreEmail] Skipping message with no Message-ID (mailboxId=${mailboxId}, storageKey=${rawStorageKey})`,
		);
		return null;
	}

	// Set `created_at` explicitly: the column default (now()) is the ingestion time, whereas
	// the reader display, the thread date (`threads.last_message_date`) and the search sort
	// are all based on `createdAt`, and a backfill of several years of mail would date
	// everything to the same day. Use the IMAP internal date (when the server received the
	// message, reliable), failing that the header date, failing that now. The header comes
	// second because mailparser replaces a missing or malformed Date header with the current
	// time without saying so; a header date more than a day in the future is ignored.
	const internalDate = (opts.metaData as any)?.imap?.internalDate;
	const headerDate =
		parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) &&
		parsed.date.getTime() <= Date.now() + 86_400_000
			? parsed.date
			: null;
	const internal =
		internalDate && !Number.isNaN(new Date(internalDate).getTime())
			? new Date(internalDate)
			: null;
	const messageDate = internal ?? headerDate ?? new Date();

	const decoratedParsed = {
		...parsed,
		date: messageDate,
		createdAt: messageDate,
		mailboxId,
		workspaceId,
		ownerId,
		headersJson: Object.fromEntries(parsed.headers as Map<string, any>),
		hasAttachments: (parsed.attachments?.length ?? 0) > 0,
		rawStorageKey,
		references: Array.isArray(parsed.references)
			? parsed.references
			: parsed.references
				? [parsed.references]
				: null,
		seen: false,
		answered: false,
		flagged: false,
		draft: false,
		html: parsed.html || "",
		sizeBytes: sizeBytes,
		snippet: generateSnippet(parsed.text || parsed.html || ""),
	} as MessageCreate | ParsedMail;

	if (opts.metaData) {
		(decoratedParsed as any).metaData = opts.metaData;
	}

	if (typeof opts.seen === "boolean") {
		(decoratedParsed as any).seen = opts.seen;
	}
	if (typeof opts.answered === "boolean") {
		(decoratedParsed as any).answered = opts.answered;
	}
	if (typeof opts.flagged === "boolean") {
		(decoratedParsed as any).flagged = opts.flagged;
	}

	const placed = await storeMessageInThread(parsed, decoratedParsed, { ownerId, workspaceId });
	if (!placed) return null;
	const message = placed.message;
	const thread = { id: placed.threadId };
	if (placed.merged) {
		try {
			const { searchIngestQueue } = await getRedis();
			await searchIngestQueue.add(
				"refresh-thread",
				{ threadId: thread.id },
				{ jobId: `kurrier-refresh-thread-${thread.id}`, delay: 5_000, removeOnComplete: true, removeOnFail: true },
			);
		} catch (err: any) {
			console.error("[parseAndStoreEmail] refresh-thread enqueue failed:", err?.message ?? err);
		}
	}
	await db
		.update(workspaces)
		.set({
			storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${sizeBytes}`,
		}).where(eq(workspaces.id, workspaceId));
	await ingestMailSubscriptionFromMessage({
		ownerId,
		workspaceId,
		parsed,
		headersJson: (decoratedParsed as any).headersJson,
	});

	const contactRes = await upsertWorkspaceSharedContactFromMessage({
		parsed,
		mailboxId,
		fallbackOwnerId: ownerId,
	});
	const contactId = contactRes?.contactIdForMessage ?? null;

	const msgDate = message.createdAt ?? new Date();
	const [t] = await db
		.select({ last: threads.lastMessageDate })
		.from(threads)
		.where(eq(threads.id, thread.id));

	if (!t?.last || new Date(t.last) < msgDate) {
		await db
			.update(threads)
			.set({ lastMessageDate: msgDate })
			.where(eq(threads.id, thread.id));
	}

	const seenIcsChecksums = new Set<string>();

	for (const attachment of parsed.attachments ?? []) {
		const bucket = process.env.S3_BUCKET!;
		const fileName = generateFileName(attachment);
		const objectPath = `private/${ownerId}/${message.id}/${fileName}`;

		await s3.send(
			new PutObjectCommand({
				Bucket: process.env.S3_BUCKET!,
				Key: objectPath,
				Body: attachment.content,
				ContentType:
					attachment.contentType || "application/octet-stream",
				CacheControl: "public, max-age=31536000",
			}),
		);

		const data = { path: objectPath };
		const error = data ? null : new Error("Failed to store attachment");
		if (error) throw error;

		const candidate: MessageAttachmentCreate = {
			ownerId,
			workspaceId,
			messageId: message.id,
			bucketId: bucket,
			path: data?.path,
			filenameOriginal: attachment.filename || null,
			contentType: attachment.contentType || "application/octet-stream",
			sizeBytes: Number(attachment.size ?? attachment.content?.length ?? 0),
			checksum: attachment.checksum || null,
			cid: attachment.cid || null,
			isInline:
				attachment.contentDisposition === "inline" || !!attachment.cid || false,
			disposition: attachment.contentDisposition || "attachment",
		} as MessageAttachmentCreate;

		const parsedRow = MessageAttachmentInsertSchema.parse(candidate);
		const [newAttachment] = await db
			.insert(messageAttachments)
			.values(parsedRow)
			.returning();

		if (mode === "live" && isIcsAttachment(attachment)) {
			const key =
				attachment.checksum || `${attachment.size}:${attachment.contentType}`;
			if (!seenIcsChecksums.has(key)) {
				seenIcsChecksums.add(key);
				icsBuffer.push({
					messageId: message.id,
					messageAttachmentId: newAttachment.id,
					mailboxId,
				});
				if (icsBuffer.length >= CALENDAR_BATCH_SIZE) {
					await flushBatches();
				} else {
					scheduleFlush();
				}
			}
		}
	}

	searchBuffer.push({
		messageId: message.id,
		contactId: String(contactId),
		ownerId,
	});
	if (searchBuffer.length >= SEARCH_BATCH_SIZE) {
		await flushBatches();
	} else {
		scheduleFlush();
	}

	if (mode === "live") {
		webhookBuffer.push({ message, rawEmail });
		rulesBuffer.push({ messageId: message.id });
		if ((webhookBuffer.length >= WEBHOOK_BATCH_SIZE) || (rulesBuffer.length >= RULES_BATCH_SIZE)) {
			await flushBatches();
		} else {
			scheduleFlush();
		}
	}

	return message;
}



async function ingestMailSubscriptionFromMessage(opts: {
	ownerId: string;
	workspaceId: string;
	parsed: ParsedMail;
	headersJson: Record<string, any>;
}) {
	// Extraction and key live in @common (list-unsubscribe), shared with the backfill.
	// An error here must never lose the message that was just inserted.
	try {
		await upsertMailSubscription({
			ownerId: opts.ownerId,
			workspaceId: opts.workspaceId,
			headers: opts.headersJson,
			fromEmail: getFromAddress(opts.parsed)?.email ?? null,
		});
	} catch (err: any) {
		console.error("[parseAndStoreEmail] mail subscription upsert failed:", err?.message ?? err);
	}
}
