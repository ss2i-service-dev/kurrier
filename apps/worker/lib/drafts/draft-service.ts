/**
 * Draft service (worker). A draft is a `messages` row in the identity's Drafts folder
 * (see packages/common/src/drafts.ts for the database layer) and a `\Draft` MIME message
 * in the IMAP Drafts folder, tracked by the X-Kurrier-Draft-Id header.
 *
 * Interface (every function takes ownerId + identityId; designed for the MCP server):
 *
 *   saveDraft({ ownerId, identityId, draftMessageId?, to, cc, bcc, subject, html, text,
 *               mode, originalMessageId, attachments, includeSignature })
 *     -> { draftMessageId, draftId, revision, savedAt }
 *     The database is updated immediately; the IMAP version follows through the
 *     `draft:sync` job (smtp-worker queue), delayed by DRAFT_IMAP_DEBOUNCE_MS, with a
 *     single job pending per draft.
 *   flushDraft({ draftMessageId })               -> pushes the IMAP version without waiting.
 *   listDrafts({ ownerId, identityId, limit?, offset? }) -> DraftSummary[]
 *   getDraft({ ownerId, identityId, draftMessageId })    -> DraftDetail | null
 *   deleteDraft({ ownerId, identityId, draftMessageId }, imapInstances?)
 *     Deletes in the database, then over IMAP (in place when connections are at hand,
 *     otherwise through the `draft:delete` job). Permanent deletion, no trip through the
 *     trash: that is what mail clients (Gmail, Thunderbird, Roundcube) do for a draft.
 *   sendDraft({ ownerId, identityId, draftMessageId, delayMs?, senderUserId? })
 *     -> { pendingSendId, undoMs }
 *     Same path as the composer (`send-and-reconcile` job, delayed and cancellable); the
 *     draft is deleted by send-mail.ts once the send succeeds.
 *
 * Jobs (smtp-worker queue, one at a time, so never two concurrent APPENDs):
 *   draft:sync   { draftMessageId }   -> syncDraftToImap
 *   draft:delete DraftImapRef         -> deleteDraftFromImap
 *
 * Replacing a version: APPEND the new one (UID from APPENDUID, otherwise looked up by
 * Message-ID), delete the old one by verified UID, then any orphans carrying the same
 * X-Kurrier-Draft-Id; the database is updated under the folder lock. On Gmail the deleted
 * version can reappear in [Gmail]/Trash: it is purged there too (best effort).
 */

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
	addressObjToList,
	DRAFT_DELETE_JOB,
	DRAFT_IMAP_DEBOUNCE_MS,
	DRAFT_SYNC_JOB,
	type DraftAttachment,
	type DraftImapRef,
	type DraftInput,
	type DraftRow,
	deleteDraftRow,
	draftDeleteJobOptions,
	draftDomain,
	draftMetaOf,
	draftSendPayload,
	draftSyncJobOptions,
	getDraftRow,
	listDraftRows,
	setDraftSendState,
	upsertDraftRow,
} from "@common";
import { db, identities, mailboxes, messages } from "@db";
import { getServerEnv } from "@schema";
import { and, eq, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { s3 } from "../create-s3-client";
import { getRedis } from "../get-redis";
import { initSmtpClient } from "../imap/imap-client";
import { resolveUids } from "../imap/imap-resolve-uids";

const serverConfig = getServerEnv();
const UNDO_SEND_MS = 30_000;

export type DraftSummary = {
	draftMessageId: string;
	draftId: string | null;
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

const summarize = (
	row: NonNullable<Awaited<ReturnType<typeof getDraftRow>>>,
): DraftSummary => {
	const meta = draftMetaOf(row);
	return {
		draftMessageId: row.id,
		draftId: meta?.draftId ?? null,
		threadId: row.threadId,
		subject: row.subject,
		snippet: row.snippet,
		to: addressObjToList(row.to),
		cc: addressObjToList(row.cc),
		bcc: addressObjToList(row.bcc),
		mode: meta?.mode ?? "new",
		originalMessageId: meta?.originalMessageId ?? null,
		hasAttachments: row.hasAttachments,
		updatedAt: row.date ?? row.updatedAt,
		imapSynced: !!meta && meta.imapRevision === meta.revision,
	};
};

// A single sync job is pending per draft: later saves within the window are absorbed (the
// job reads the database state at the time it runs).
export async function enqueueDraftSync(
	draftMessageId: string,
	delayMs = DRAFT_IMAP_DEBOUNCE_MS,
) {
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(
		DRAFT_SYNC_JOB,
		{ draftMessageId },
		draftSyncJobOptions(draftMessageId, delayMs),
	);
}

export async function enqueueDraftDelete(ref: DraftImapRef) {
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(DRAFT_DELETE_JOB, ref, draftDeleteJobOptions());
}

export async function saveDraft(input: DraftInput) {
	const saved = await upsertDraftRow(input);
	await enqueueDraftSync(saved.id);
	return {
		draftMessageId: saved.id,
		draftId: saved.draftId,
		revision: saved.revision,
		savedAt: saved.savedAt,
	};
}

export const flushDraft = ({ draftMessageId }: { draftMessageId: string }) =>
	enqueueDraftSync(draftMessageId, 0);

export async function listDrafts(opts: {
	ownerId: string;
	identityId: string;
	limit?: number;
	offset?: number;
}): Promise<DraftSummary[]> {
	return (await listDraftRows(opts)).map(summarize);
}

export async function getDraft(opts: {
	ownerId: string;
	identityId: string;
	draftMessageId: string;
}) {
	const row = await getDraftRow(opts);
	if (!row) return null;
	const [box] = await db
		.select({ identityId: mailboxes.identityId })
		.from(mailboxes)
		.where(eq(mailboxes.id, row.mailboxId));
	if (!box || box.identityId !== opts.identityId) return null;
	const meta = draftMetaOf(row);
	return {
		...summarize(row),
		html: row.html ?? "",
		text: row.text ?? "",
		attachments: meta?.attachments ?? [],
		includeSignature: meta?.includeSignature !== false,
		quoteScope: meta?.quoteScope ?? null,
	};
}

export async function deleteDraft(
	opts: { ownerId: string; identityId: string; draftMessageId: string },
	imapInstances?: Map<string, ImapFlow>,
) {
	const ref = await deleteDraftRow(opts);
	if (!ref) return { deleted: false as const };
	if (imapInstances) await deleteDraftFromImap(ref, imapInstances);
	else await enqueueDraftDelete(ref);
	return { deleted: true as const };
}

export async function sendDraft(opts: {
	ownerId: string;
	identityId: string;
	draftMessageId: string;
	delayMs?: number;
	senderUserId?: string | null;
}) {
	const payload = await draftSendPayload(opts);
	if (payload.identityId !== opts.identityId)
		throw new Error("Draft not found");
	const { sendMailQueue } = await getRedis();
	const delay = opts.delayMs ?? UNDO_SEND_MS;
	const job = await sendMailQueue.add("send-and-reconcile", payload, {
		jobId: `undo-send-${crypto.randomUUID()}`,
		delay,
	});
	// Mark the draft as "sending": the Drafts list and the draft view display it.
	await setDraftSendState(opts.draftMessageId, {
		pendingSend: {
			jobId: String(job.id),
			sendAt: new Date(Date.now() + delay).toISOString(),
		},
		sendError: null,
	});
	return { pendingSendId: String(job.id), undoMs: delay };
}

// ---------------------------------------------------------------------------
// IMAP

async function streamToBuffer(stream: any): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const chunks: any[] = [];
		stream.on("data", (chunk: any) => chunks.push(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(Buffer.concat(chunks)));
	});
}

async function loadAttachments(list: DraftAttachment[]) {
	const out: { filename: string; content: Buffer; contentType: string }[] = [];
	for (const att of list) {
		try {
			const res = await s3.send(
				new GetObjectCommand({ Bucket: serverConfig.S3_BUCKET, Key: att.path }),
			);
			if (!res.Body) continue;
			out.push({
				filename: att.filenameOriginal || "attachment",
				content: await streamToBuffer(res.Body),
				contentType: att.contentType || "application/octet-stream",
			});
		} catch (err: any) {
			console.error(
				`[draft] attachment unreadable ${att.path}:`,
				err?.message ?? err,
			);
		}
	}
	return out;
}

async function buildDraftMime(opts: {
	messageId: string;
	draftId: string;
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	text: string;
	html: string;
	inReplyTo: string | null;
	references: string[];
	attachments: { filename: string; content: Buffer; contentType: string }[];
	date: Date;
}) {
	const composer = new MailComposer({
		messageId: opts.messageId,
		from: opts.from,
		to: opts.to,
		cc: opts.cc,
		bcc: opts.bcc,
		subject: opts.subject,
		text: opts.text,
		html: opts.html,
		inReplyTo: opts.inReplyTo || undefined,
		references: opts.references.length ? opts.references : undefined,
		date: opts.date,
		headers: { "X-Kurrier-Draft-Id": opts.draftId },
		attachments: opts.attachments,
	} as any);
	return await new Promise<Buffer>((resolve, reject) => {
		composer.compile().build((err: any, message: Buffer) => {
			if (err) reject(err);
			else resolve(message);
		});
	});
}

const isGmailPath = (p: string | null | undefined) =>
	/^\[gmail\]/i.test(String(p ?? ""));

// Gmail: deleting from Drafts can leave a copy in the trash (depending on the account's
// IMAP settings). Look it up there by Message-ID and delete it; best effort.
async function purgeGmailTrashCopies(
	client: ImapFlow,
	identityId: string,
	messageIds: string[],
) {
	const ids = messageIds.map((m) => m.trim()).filter(Boolean);
	if (!ids.length) return;
	const [trash] = await db
		.select()
		.from(mailboxes)
		.where(
			and(eq(mailboxes.identityId, identityId), eq(mailboxes.kind, "trash")),
		)
		.limit(1);
	const trashPath = (trash?.metaData as any)?.imap?.path as string | undefined;
	if (!trashPath || !isGmailPath(trashPath)) return;
	try {
		const lock = await client.getMailboxLock(trashPath);
		try {
			const uids: number[] = [];
			for (const id of ids) {
				const found = await client.search(
					{ header: { "message-id": id } },
					{ uid: true },
				);
				if (Array.isArray(found)) uids.push(...found);
			}
			if (uids.length) await client.messageDelete(uids, { uid: true });
		} finally {
			lock.release();
		}
	} catch (err: any) {
		console.warn(
			`[draft] Gmail trash purge failed:`,
			err?.message ?? err,
		);
	}
}

// Versions to delete in the current folder: the known UID (verified by Message-ID) and any
// orphan carrying the same X-Kurrier-Draft-Id. Call with the lock held.
async function staleVersionUids(
	client: ImapFlow,
	ref: { uid: number | null; messageId: string; draftId: string },
	keepUid?: number,
) {
	const uids = new Set<number>();
	if (ref.uid) {
		const resolved = await resolveUids(client, [
			{ id: "draft", uid: ref.uid, messageId: ref.messageId },
		]);
		for (const u of resolved.keys()) uids.add(u);
	}
	if (ref.draftId) {
		const found = await client
			.search({ header: { "x-kurrier-draft-id": ref.draftId } }, { uid: true })
			.catch(() => false as const);
		if (Array.isArray(found)) for (const u of found) uids.add(u);
	}
	if (keepUid) uids.delete(keepUid);
	return [...uids];
}

/**
 * Pushes the draft's current state to the IMAP Drafts folder and removes the previous
 * version. No-op if nothing changed since the last pushed version.
 */
export async function syncDraftToImap(
	{ draftMessageId }: { draftMessageId: string },
	imapInstances: Map<string, ImapFlow>,
) {
	const [found] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, draftMessageId), eq(messages.draft, true)))
		.limit(1);
	if (!found) return;
	const row = found as DraftRow;
	const meta = draftMetaOf(row);
	if (!meta || meta.imapRevision === meta.revision) return;
	const revision = meta.revision;

	const [box] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, row.mailboxId))
		.limit(1);
	if (!box) return;
	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, box.identityId))
		.limit(1);
	if (!identity) return;

	const markSynced = (extra: Record<string, unknown> = {}) =>
		db
			.update(messages)
			.set({
				...extra,
				metaData: sql`jsonb_set(coalesce(${messages.metaData}, '{}'::jsonb), '{draft,imapRevision}', to_jsonb(${revision}::int), true)`,
			})
			.where(and(eq(messages.id, row.id), eq(messages.draft, true)))
			.returning({ id: messages.id });

	// Identity without an IMAP account: the database is authoritative, nothing to push.
	if (!identity.smtpAccountId) {
		await markSynced();
		return;
	}

	const path = String((box.metaData as any)?.imap?.path ?? box.name ?? "");
	if (!path)
		throw new Error(
			`[draft] Drafts folder has no IMAP path (mailbox ${box.id})`,
		);

	const from = identity.displayName
		? `${identity.displayName} <${identity.value}>`
		: identity.value;
	const newMessageId = `<draft-${meta.draftId}.${revision}@${draftDomain(identity.value)}>`;
	const eml = await buildDraftMime({
		messageId: newMessageId,
		draftId: meta.draftId,
		from,
		to: addressObjToList(row.to),
		cc: addressObjToList(row.cc),
		bcc: addressObjToList(row.bcc),
		subject: row.subject ?? "",
		text: row.text ?? "",
		html: row.html ?? "",
		inReplyTo: row.inReplyTo ?? null,
		references: Array.isArray(row.references) ? row.references : [],
		attachments: await loadAttachments(meta.attachments ?? []),
		date: row.date ?? new Date(),
	});

	const client = await initSmtpClient(identity.id, imapInstances);
	if (!client?.authenticated || !client.usable) {
		throw new Error(
			`[draft] IMAP connection unavailable (identity ${identity.id})`,
		);
	}

	const previous = {
		uid: (row.metaData as any)?.imap?.uid
			? Number((row.metaData as any).imap.uid)
			: null,
		messageId: row.messageId,
		draftId: meta.draftId,
	};
	const previousPath = (row.metaData as any)?.imap?.mailboxPath as
		| string
		| undefined;

	const lock = await client.getMailboxLock(path);
	try {
		const appended = await client.append(
			path,
			eml,
			["\\Draft", "\\Seen"],
			row.date ?? new Date(),
		);
		let newUid = appended && appended.uid ? Number(appended.uid) : undefined;
		if (!newUid) {
			// No UIDPLUS: find the version we just wrote by its Message-ID.
			const found = await resolveUids(client, [
				{ id: "new", uid: 0, messageId: newMessageId },
			]);
			newUid = [...found.keys()].sort((a, b) => b - a)[0];
		}

		// Previous version and orphans, in this folder.
		if (!previousPath || previousPath === path) {
			const stale = await staleVersionUids(client, previous, newUid);
			if (stale.length) await client.messageDelete(stale, { uid: true });
		}

		const rawStorageKey = `eml/${row.ownerId}/${row.mailboxId}/${row.id}.eml`;
		await s3.send(
			new PutObjectCommand({
				Bucket: serverConfig.S3_BUCKET,
				Key: rawStorageKey,
				Body: eml,
				ContentType: "message/rfc822",
			}),
		);

		const updated = await db
			.update(messages)
			.set({
				messageId: newMessageId,
				rawStorageKey,
				sizeBytes: eml.length,
				metaData: sql`jsonb_set(jsonb_set(coalesce(${messages.metaData}, '{}'::jsonb), '{imap}', ${JSON.stringify(
					{
						uid: newUid ?? null,
						mailboxPath: path,
						flags: ["\\Draft", "\\Seen"],
					},
				)}::jsonb, true), '{draft,imapRevision}', to_jsonb(${revision}::int), true)`,
			})
			.where(and(eq(messages.id, row.id), eq(messages.draft, true)))
			.returning({ id: messages.id });

		// Draft sent or discarded during the APPEND: the version just written is surplus.
		if (!updated.length && newUid) {
			await client.messageDelete([newUid], { uid: true });
		}
	} finally {
		lock.release();
	}

	if (previous.uid && (!previousPath || previousPath === path)) {
		await purgeGmailTrashCopies(client, identity.id, [previous.messageId]);
	}
}

/** Deletes the IMAP version of a draft already removed from the database. */
export async function deleteDraftFromImap(
	ref: DraftImapRef,
	imapInstances: Map<string, ImapFlow>,
) {
	if (!ref.mailboxPath) return;
	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, ref.identityId))
		.limit(1);
	if (!identity?.smtpAccountId) return;
	const client = await initSmtpClient(ref.identityId, imapInstances);
	if (!client?.authenticated || !client.usable) {
		throw new Error(
			`[draft] IMAP connection unavailable (identity ${ref.identityId})`,
		);
	}
	const lock = await client.getMailboxLock(ref.mailboxPath);
	try {
		const stale = await staleVersionUids(client, ref);
		if (stale.length) await client.messageDelete(stale, { uid: true });
	} finally {
		lock.release();
	}
	await purgeGmailTrashCopies(client, ref.identityId, [ref.messageId]);
}
