import {
	db,
	identities,
	mailboxes,
	mailboxThreads,
	messages,
	threads,
} from "@db";
import type { AddressObjectJSON } from "@schema";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import { generateSnippet, upsertMailboxThreadItem } from "./mail";
import type { QuoteMode, QuoteScope } from "./compose";
import { addressObjToList } from "./mail-client";

export { addressObjToList };
export * from "./draft-send";
import { draftTimesOf, mergeDraftMeta, type DraftPendingSend, type DraftSendError } from "./draft-send";

/**
 * Drafts, database layer (shared by the web app and the worker).
 *
 * A draft is a `messages` row of the identity's `drafts` folder, `draft = true`, whose
 * `meta.draft` carries what the editor must find again (mode, original message,
 * attachments, revision) and `meta.imap` the version pushed to the IMAP Drafts folder.
 *
 * - `revision` is incremented on every save; `imapRevision` is the last revision pushed
 *   over IMAP (worker, lib/drafts/draft-service.ts). When both are equal there is
 *   nothing to push.
 * - `draftId` is stable from one version to the next (X-Kurrier-Draft-Id header of the
 *   MIME); the Message-ID changes on every pushed version, as Gmail deduplicates by Message-ID.
 */

export const DRAFT_SYNC_JOB = "draft:sync";
export const DRAFT_DELETE_JOB = "draft:delete";
// Cadence of the IMAP version: the database is up to date on every keystroke (3 s), the
// IMAP folder follows at this pace. Each pushed version replaces one; on Gmail the deleted
// version may transit through the trash, hence the slow pace.
export const DRAFT_IMAP_DEBOUNCE_MS = 45_000;

// BullMQ options of the `draft:sync` job (smtp-worker queue), the same on the web and the
// worker side: a single job waiting per draft during the window, later saves are absorbed
// (the job reads the database state when it runs). delayMs = 0: right away.
export const draftSyncJobOptions = (
	draftMessageId: string,
	delayMs = DRAFT_IMAP_DEBOUNCE_MS,
) => ({
	delay: delayMs,
	deduplication:
		delayMs > 0
			? { id: `draft-sync-${draftMessageId}`, ttl: delayMs }
			: undefined,
	removeOnComplete: true,
	removeOnFail: true,
	attempts: 3,
	backoff: { type: "exponential", delay: 5000 },
});

export const draftDeleteJobOptions = () => ({
	removeOnComplete: true,
	removeOnFail: true,
	attempts: 3,
	backoff: { type: "exponential", delay: 5000 },
});

export type DraftMode = "new" | "reply" | "forward";

export type DraftAttachment = {
	path: string;
	filenameOriginal?: string | null;
	contentType?: string | null;
	sizeBytes?: number | null;
	messageId?: string | null;
};

export type DraftMeta = {
	draftId: string;
	mode: DraftMode;
	originalMessageId: string | null;
	attachments: DraftAttachment[];
	includeSignature: boolean;
	// Quote scope of a reply (see compose.ts); absent = whole message.
	quoteScope?: QuoteScope;
	// Edited quote (custom + quoteHtml) or removed (none); absent = auto.
	quoteMode?: QuoteMode;
	quoteHtml?: string;
	revision: number;
	imapRevision?: number;
	// Creation of the draft (first save), kept from one save to the next, even when the draft
	// changes Drafts folder (sender change).
	createdAt?: string;
	// Last save (last edit).
	savedAt?: string;
	// Send in progress (deferred or running send-and-reconcile job): set by the send action
	// (web and MCP), cleared by the cancellation or the worker. The draft disappears on success.
	pendingSend?: DraftPendingSend;
	// Last failed send (set by the worker when the job fails for good).
	sendError?: DraftSendError;
};

// Writes (object) or clears (null) pendingSend / sendError in meta.draft, by jsonb_set on
// these keys only: a concurrent autosave or IMAP sync (meta.imap) is not overwritten. A
// key absent from the patch is left untouched.
export async function setDraftSendState(
	draftMessageId: string,
	patch: {
		pendingSend?: DraftPendingSend | null;
		sendError?: DraftSendError | null;
	},
) {
	let expr = sql`coalesce(${messages.metaData}, '{}'::jsonb)`;
	for (const key of ["pendingSend", "sendError"] as const) {
		if (!(key in patch)) continue;
		const value = patch[key];
		const path = `{draft,${key}}`;
		expr =
			value == null
				? sql`(${expr}) #- ${path}::text[]`
				: sql`jsonb_set(${expr}, ${path}::text[], ${JSON.stringify(value)}::jsonb, true)`;
	}
	await db
		.update(messages)
		.set({ metaData: expr })
		.where(and(eq(messages.id, draftMessageId), eq(messages.draft, true)));
}

export type DraftInput = {
	ownerId: string;
	identityId: string;
	// Existing row to update; absent = new draft.
	draftMessageId?: string | null;
	to?: string[] | string | null;
	cc?: string[] | string | null;
	bcc?: string[] | string | null;
	subject?: string | null;
	html?: string | null;
	text?: string | null;
	mode?: DraftMode | null;
	originalMessageId?: string | null;
	attachments?: DraftAttachment[] | string | null;
	includeSignature?: boolean | string | null;
	quoteScope?: QuoteScope | string | null;
	quoteMode?: QuoteMode | string | null;
	quoteHtml?: string | null;
};

// What is needed to find the IMAP version of a draft once its row is deleted.
export type DraftImapRef = {
	identityId: string;
	mailboxId: string;
	mailboxPath: string | null;
	uid: number | null;
	messageId: string;
	draftId: string;
};

export type DraftRow = typeof messages.$inferSelect;

export const draftMetaOf = (row: { metaData: Record<string, any> | null }) =>
	((row.metaData as any)?.draft ?? null) as DraftMeta | null;

export const toAddressList = (
	input: string | string[] | null | undefined,
): string[] =>
	(Array.isArray(input) ? input : String(input ?? "").split(","))
		.map((s) => s.trim())
		.filter(Boolean);

// "Name <address>" or "address" -> address object as stored by `messages`.
export function parseAddressList(
	input: string | string[] | null | undefined,
): AddressObjectJSON {
	const value = toAddressList(input).map((raw) => {
		const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
		return m
			? { name: (m[1] ?? "").trim(), address: m[2].trim() }
			: { name: "", address: raw };
	});
	const joined = value
		.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address))
		.join(", ");
	return { value, html: joined, text: joined } as AddressObjectJSON;
}

function parseAttachments(
	input: DraftAttachment[] | string | null | undefined,
): DraftAttachment[] {
	let list: unknown = input ?? [];
	if (typeof input === "string") {
		try {
			list = input ? JSON.parse(input) : [];
		} catch {
			list = [];
		}
	}
	return (Array.isArray(list) ? list : [])
		.filter((a: any) => a && typeof a.path === "string" && a.path)
		.map((a: any) => ({
			path: String(a.path),
			filenameOriginal: a.filenameOriginal ?? null,
			contentType: a.contentType ?? null,
			sizeBytes: a.sizeBytes == null ? null : Number(a.sizeBytes),
			messageId: a.messageId ?? null,
		}));
}

const draftMessageId = (draftId: string, revision: number, domain: string) =>
	`<draft-${draftId}.${revision}@${domain}>`;

export const draftDomain = (identityValue: string) =>
	identityValue.split("@")[1]?.trim() || "kurrier.local";

async function draftsMailboxFor(identityId: string) {
	const [box] = await db
		.select()
		.from(mailboxes)
		.where(
			and(eq(mailboxes.identityId, identityId), eq(mailboxes.kind, "drafts")),
		)
		.orderBy(desc(mailboxes.isDefault))
		.limit(1);
	return box ?? null;
}

/**
 * Saves (creates or updates) a draft in the database and refreshes the Drafts folder row.
 * Does not touch IMAP: the worker's `draft:sync` job pushes the version.
 */
export async function upsertDraftRow(input: DraftInput) {
	const [identity] = await db
		.select()
		.from(identities)
		.where(
			and(
				eq(identities.id, input.identityId),
				eq(identities.ownerId, input.ownerId),
			),
		)
		.limit(1);
	if (!identity) throw new Error("Identity not found");

	const box = await draftsMailboxFor(identity.id);
	if (!box) throw new Error("No Drafts folder for this identity");

	let existing: DraftRow | null = input.draftMessageId
		? (((
				await db
					.select()
					.from(messages)
					.where(
						and(
							eq(messages.id, String(input.draftMessageId)),
							eq(messages.ownerId, input.ownerId),
							eq(messages.draft, true),
						),
					)
					.limit(1)
			)[0] as DraftRow | undefined) ?? null)
		: null;
	if (input.draftMessageId && !existing) throw new Error("Draft not found");

	// The sender (From) changed identity: the draft changes Drafts folder. Start again from
	// a new row and the caller deletes the old IMAP version (`replaced`).
	let replaced: DraftImapRef | null = null;
	// Draft creation, read before a possible folder change (new row).
	const createdAt = existing ? draftTimesOf(existing).createdAt : null;
	if (existing && existing.mailboxId !== box.id) {
		replaced = await deleteDraftRow({
			ownerId: input.ownerId,
			draftMessageId: existing.id,
		});
		existing = null;
	}

	const prevMeta = existing ? draftMetaOf(existing) : null;
	const mode: DraftMode =
		input.mode === "reply" || input.mode === "forward" ? input.mode : "new";
	const originalMessageId =
		input.originalMessageId ?? prevMeta?.originalMessageId ?? null;

	// Original message (reply or forward): thread and reference headers.
	const [orig] = originalMessageId
		? await db
				.select({
					id: messages.id,
					threadId: messages.threadId,
					messageId: messages.messageId,
					references: messages.references,
				})
				.from(messages)
				.where(
					and(
						eq(messages.id, originalMessageId),
						eq(messages.ownerId, input.ownerId),
					),
				)
				.limit(1)
		: [];

	// A forward is attached to the original thread like a reply (send-mail.ts).
	const threaded = mode === "reply" || mode === "forward";
	const inReplyTo = threaded && orig ? orig.messageId : null;
	const references =
		threaded && orig
			? Array.from(
					new Set(
						[
							...(Array.isArray(orig.references) ? orig.references : []),
							orig.messageId,
						].filter(Boolean),
					),
				).slice(-30)
			: [];

	const to = parseAddressList(input.to);
	const cc = parseAddressList(input.cc);
	const bcc = parseAddressList(input.bcc);
	const attachments = parseAttachments(input.attachments);
	const includeSignature =
		input.includeSignature == null
			? (prevMeta?.includeSignature ?? true)
			: input.includeSignature !== false && input.includeSignature !== "false";
	const quoteScope: QuoteScope | undefined =
		input.quoteScope === "last" || input.quoteScope === "thread"
			? input.quoteScope
			: prevMeta?.quoteScope;
	// An absent value keeps the previous one; "auto" clears the edited HTML.
	const quoteMode: QuoteMode | undefined =
		input.quoteMode === "auto" || input.quoteMode === "custom" || input.quoteMode === "none"
			? input.quoteMode
			: prevMeta?.quoteMode;
	const quoteHtml: string | undefined =
		quoteMode === "custom"
			? typeof input.quoteHtml === "string" && input.quoteHtml !== ""
				? input.quoteHtml
				: prevMeta?.quoteHtml
			: undefined;
	const html = input.html ?? "";
	const text = input.text ?? "";
	const subject = (input.subject ?? "").trim();
	const now = new Date();
	const revision = (prevMeta?.revision ?? 0) + 1;
	const draftId = prevMeta?.draftId ?? crypto.randomUUID();

	const draftMeta: DraftMeta = mergeDraftMeta(prevMeta, {
		draftId,
		mode,
		originalMessageId,
		attachments,
		includeSignature,
		...(quoteScope ? { quoteScope } : {}),
		...(quoteMode && quoteMode !== "auto" ? { quoteMode } : {}),
		...(quoteMode === "custom" && quoteHtml ? { quoteHtml } : {}),
		revision,
		createdAt: createdAt ?? now.toISOString(),
		savedAt: now.toISOString(),
	});

	const fields = {
		subject,
		snippet: generateSnippet(text || html || ""),
		html,
		text,
		to,
		cc,
		bcc,
		inReplyTo,
		references,
		hasAttachments: attachments.length > 0,
		date: now,
		seen: true,
		draft: true,
		updatedAt: now,
	};

	let row: DraftRow;
	if (existing) {
		// `meta.imap` (IMAP version) is updated by the worker, sometimes at the same time:
		// only the `draft` key is rewritten, never the whole jsonb.
		const [updated] = await db
			.update(messages)
			.set({
				...fields,
				// pendingSend is taken from the database at write time (send set between the read and
				// here).
				metaData: sql`jsonb_set(coalesce(${messages.metaData}, '{}'::jsonb), '{draft}', (${JSON.stringify(draftMeta)}::jsonb - 'pendingSend') || case when ${messages.metaData} #> '{draft,pendingSend}' is not null then jsonb_build_object('pendingSend', ${messages.metaData} #> '{draft,pendingSend}') else '{}'::jsonb end, true)`,
			})
			.where(eq(messages.id, existing.id))
			.returning();
		row = updated as DraftRow;
	} else {
		const threadId = await db.transaction(async (tx) => {
			if (threaded && orig?.threadId) return orig.threadId;
			const [t] = await tx
				.insert(threads)
				.values({
					ownerId: input.ownerId,
					workspaceId: box.workspaceId,
					lastMessageDate: now,
				})
				.returning({ id: threads.id });
			return t.id;
		});
		const [created] = await db
			.insert(messages)
			.values({
				...fields,
				ownerId: input.ownerId,
				workspaceId: box.workspaceId,
				mailboxId: box.id,
				threadId,
				messageId: draftMessageId(draftId, 0, draftDomain(identity.value)),
				from: parseAddressList(
					identity.displayName
						? `${identity.displayName} <${identity.value}>`
						: identity.value,
				),
				metaData: { draft: draftMeta },
			})
			.returning();
		row = created as DraftRow;
	}

	await upsertMailboxThreadItem(row.id);
	// The upsert accumulates (OR) the presence of attachments and keeps the old snippet when
	// the new one is empty: for the Drafts folder, we reflect the current state.
	await db
		.update(mailboxThreads)
		.set({
			previewText: fields.snippet,
			hasAttachments: sql`exists (select 1 from ${messages} m where m.thread_id = ${mailboxThreads.threadId} and m.mailbox_id = ${mailboxThreads.mailboxId} and m.has_attachments)`,
		})
		.where(
			and(
				eq(mailboxThreads.threadId, row.threadId),
				eq(mailboxThreads.mailboxId, box.id),
			),
		);

	return {
		id: row.id,
		draftId,
		revision,
		savedAt: now,
		createdAt: draftMeta.createdAt ?? now.toISOString(),
		threadId: row.threadId,
		mailboxId: box.id,
		identityId: identity.id,
		replaced,
	};
}

export async function getDraftRow(opts: {
	ownerId: string;
	draftMessageId: string;
}): Promise<DraftRow | null> {
	const [row] = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.id, opts.draftMessageId),
				eq(messages.ownerId, opts.ownerId),
				eq(messages.draft, true),
			),
		)
		.limit(1);
	return (row as DraftRow | undefined) ?? null;
}

export async function listDraftRows(opts: {
	ownerId: string;
	identityId: string;
	limit?: number;
	offset?: number;
}): Promise<DraftRow[]> {
	const box = await draftsMailboxFor(opts.identityId);
	if (!box) return [];
	return (await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, box.id),
				eq(messages.ownerId, opts.ownerId),
				eq(messages.draft, true),
			),
		)
		.orderBy(desc(sql`coalesce(${messages.date}, ${messages.createdAt})`))
		.limit(Math.min(Math.max(opts.limit ?? 50, 1), 500))
		.offset(Math.max(opts.offset ?? 0, 0))) as DraftRow[];
}

export function draftImapRef(
	row: DraftRow,
	box: {
		id: string;
		identityId: string;
		metaData: Record<string, any> | null;
		name: string | null;
	},
): DraftImapRef {
	const imap = (row.metaData as any)?.imap ?? {};
	return {
		identityId: box.identityId,
		mailboxId: box.id,
		mailboxPath:
			imap.mailboxPath ?? box.metaData?.imap?.path ?? box.name ?? null,
		uid: imap.uid ? Number(imap.uid) : null,
		messageId: row.messageId,
		draftId: draftMetaOf(row)?.draftId ?? "",
	};
}

/**
 * Deletes the draft in the database (row, Drafts folder summary, thread if empty) and
 * returns what is needed to delete its IMAP version. Null if the row does not exist (any more).
 */
export async function deleteDraftRow(opts: {
	ownerId: string;
	draftMessageId: string;
}): Promise<DraftImapRef | null> {
	const row = await getDraftRow(opts);
	if (!row) return null;
	const [box] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, row.mailboxId))
		.limit(1);
	if (!box) return null;
	const ref = draftImapRef(row, box as typeof mailboxes.$inferSelect);

	await db.transaction(async (tx) => {
		await tx.delete(messages).where(eq(messages.id, row.id));
		const [newest] = await tx
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.threadId, row.threadId),
					eq(messages.mailboxId, box.id),
				),
			)
			.orderBy(desc(sql`coalesce(${messages.date}, ${messages.createdAt})`))
			.limit(1);
		if (newest?.id) {
			await upsertMailboxThreadItem(newest.id, tx as any);
		} else {
			await tx
				.delete(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.threadId, row.threadId),
						eq(mailboxThreads.mailboxId, box.id),
					),
				);
		}
		await tx
			.delete(threads)
			.where(
				and(
					eq(threads.id, row.threadId),
					notExists(
						tx
							.select({ one: sql`1` })
							.from(messages)
							.where(eq(messages.threadId, threads.id)),
					),
				),
			);
	});

	return ref;
}

/**
 * Send payload of a draft, in the form `send-and-reconcile` expects (the composer form's,
 * see apps/web/lib/actions/mailbox.ts sendMail).
 */
export async function draftSendPayload(opts: {
	ownerId: string;
	draftMessageId: string;
	senderUserId?: string | null;
}) {
	const row = await getDraftRow(opts);
	if (!row) throw new Error("Draft not found");
	const meta = draftMetaOf(row);
	const [box] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, row.mailboxId))
		.limit(1);
	if (!box) throw new Error("Mailbox not found");
	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, box.identityId))
		.limit(1);
	if (!identity) throw new Error("Identity not found");
	const boxes = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.identityId, identity.id));
	const sent = boxes.find((b) => b.kind === "sent");
	const inbox = boxes.find((b) => b.kind === "inbox");
	if (!sent || !inbox)
		throw new Error("Required mailboxes (inbox and sent) not found");

	const to = addressObjToList(row.to);
	if (!to.length)
		throw new Error("Please provide at least one recipient in the To field.");

	return {
		identityPublicId: identity.publicId,
		identityId: identity.id,
		sentMailboxId: sent.id,
		mailboxId: inbox.id,
		senderUserId: opts.senderUserId ?? identity.ownerId,
		to,
		cc: addressObjToList(row.cc),
		bcc: addressObjToList(row.bcc),
		subject: row.subject ?? "",
		html: row.html ?? "",
		text: row.text ?? "",
		mode: meta?.mode ?? "new",
		originalMessageId: meta?.originalMessageId ?? undefined,
		attachments: JSON.stringify(meta?.attachments ?? []),
		includeSignature: meta?.includeSignature === false ? "false" : "true",
		quoteScope: meta?.quoteScope,
		quoteMode: meta?.quoteMode,
		quoteHtml: meta?.quoteHtml,
		newMessageId: crypto.randomUUID(),
		draftMessageId: row.id,
	};
}
