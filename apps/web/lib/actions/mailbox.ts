"use server";

import { cache } from "react";
import {getWorkspacePublicId, rlsClient} from "@/lib/actions/clients";
import {
	db,
	DraftMessageInsertSchema,
	draftMessages,
	identities,
	mailboxes,
	mailboxSync, MailboxThreadEntity,
	mailboxThreads, mailSubscriptions,
	messageAttachments,
	messages,
	threads, workspaces,
} from "@db";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
	gt,
	notInArray,
} from "drizzle-orm";
import { NO_UNREAD_COUNT_KINDS } from "@/lib/folder-unread-counts";
import { revalidatePath } from "next/cache";
import {
	FormState,
	getServerEnv,
	handleAction,
	SearchThreadsResponse,
} from "@schema";
import { decode } from "decode-formdata";
import { toArray } from "@/lib/utils";

import Typesense, { Client } from "typesense";
import { isSignedIn } from "@/lib/actions/auth";
import slugify from "@sindresorhus/slugify";
import { redirect } from "next/navigation";
import { PAGE_SIZE } from "@common/mail-client";
import { cancelSend, enqueueSend, sendNowPlanOf, dismissRestoresDraft, isOutboxVisible, outboxActionsOf, outboxCountOf, sendStateOf, type OutboxActions, type SendState, extractListUnsubscribe, imapDraftIdOfJob, pendingSendLive, interruptedSendOf, deleteDraftRow, DRAFT_DELETE_JOB, draftDeleteJobOptions, type SettleAction, scheduledJobOf, scheduledPendingSend, subscriptionKeyOf, draftSendStateOf, draftTimesOf, setDraftSendState, shouldMoveImap, validateScheduledAt, parseExpiry, SCHEDULED_JOB, type DraftSendState, type DraftTimes } from "@common";
import { getRedis } from "@/lib/actions/get-redis";
import { saveDraft } from "@/lib/actions/drafts";
import { undoSendSeconds } from "@/lib/actions/undo-send";
import dayjs from "dayjs";
import {fetchWorkspace} from "@/lib/actions/workspace";
import {
	assertIdentityAccess,
	assertMailboxAccess,
	assertMessageAccess,
	assertOwnedS3Key,
	assertSignedIn,
	assertThreadsInMailbox,
	isUuid,
} from "@/lib/authz";

import {GetObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "@/lib/create-s3-client";
import { attachmentUrls } from "@/lib/attachment-links";
import type { OutboxTracking } from "@/lib/outbox-view";

let typeSenseClient: Client | null = null;
function getTypeSenseClient(): Client {
	if (typeSenseClient) return typeSenseClient;

	const {
		TYPESENSE_API_KEY,
		TYPESENSE_PORT,
		TYPESENSE_PROTOCOL,
		TYPESENSE_HOST,
	} = getServerEnv();

	typeSenseClient = new Typesense.Client({
		nodes: [
			{
				host: TYPESENSE_HOST,
				port: Number(TYPESENSE_PORT),
				protocol: TYPESENSE_PROTOCOL,
			},
		],
		apiKey: TYPESENSE_API_KEY,
	});

	return typeSenseClient;
}


export const fetchMailbox = cache(
	async (identityPublicId: string, mailboxSlug = "inbox") => {
		const rls = await rlsClient();

		const [identity] = await rls((tx) =>
			tx
				.select()
				.from(identities)
				.where(eq(identities.publicId, identityPublicId))
				.limit(1)
		);

		// Identity and mailbox in the message (server log) to find the faulty request.
		// A URL must never block (previous or reload used to leave a broken page): unknown
		// identity -> mail home, unknown mailbox (undefined, search or label view, deleted
		// mailbox, old link) -> Inbox of the identity.
		if (!identity) {
			console.warn(`[fetchMailbox] Identity not found: identity=${identityPublicId} slug=${mailboxSlug}, redirecting`);
			redirect(`/w/${await getWorkspacePublicId()}/dashboard/mail`);
		}

		const [mailboxList, activeMailbox] = await Promise.all([
			rls((tx) =>
				tx
					.select()
					.from(mailboxes)
					.where(eq(mailboxes.identityId, identity.id))
			),

			rls((tx) =>
				tx
					.select()
					.from(mailboxes)
					.where(
						and(
							eq(mailboxes.identityId, identity.id),
							eq(mailboxes.slug, mailboxSlug)
						)
					)
					.limit(1)
			).then((rows) => rows[0]),
		]);

		if (!activeMailbox) {
			console.warn(`[fetchMailbox] Mailbox not found: identity=${identityPublicId} slug=${mailboxSlug}, redirecting`);
			const ws = await getWorkspacePublicId();
			redirect(mailboxSlug === "inbox" ? `/w/${ws}/dashboard/mail` : `/w/${ws}/dashboard/mail/${identityPublicId}/inbox`);
		}

		const [messagesCountRow, sync] = await Promise.all([
			// Number of listed threads (same filter as fetchMailboxThreads), not of messages:
			// the pagination takes its number of pages from it (lib/mail-pagination.ts).
			rls((tx) =>
				tx
					.select({ count: count() })
					.from(mailboxThreads)
					.where(
						and(
							eq(mailboxThreads.identityPublicId, identityPublicId),
							eq(mailboxThreads.mailboxSlug, mailboxSlug),
							or(
								isNull(mailboxThreads.snoozedUntil),
								lte(mailboxThreads.snoozedUntil, new Date()),
							),
						),
					)
			).then((rows) => rows[0]),

			rls((tx) =>
				tx
					.select()
					.from(mailboxSync)
					.where(eq(mailboxSync.mailboxId, activeMailbox.id))
					.limit(1)
			).then((rows) => rows[0] ?? null),
		]);

		return {
			activeMailbox,
			mailboxList,
			identity,
			count: Number(messagesCountRow?.count ?? 0),
			mailboxSync: sync,
		};
	}
);




export type FetchMailboxResult = Awaited<
	ReturnType<typeof fetchMailbox>
>;



export const fetchIdentityMailboxList = cache(async () => {
	const rls = await rlsClient();

	const rows = await rls((tx) =>
		tx
			.select({ identity: identities, mailbox: mailboxes })
			.from(identities)
			.leftJoin(
				mailboxes,
				and(
					eq(identities.id, mailboxes.identityId),
					// The Drafts mailbox is displayed (IMAP drafts).
					sql`${mailboxes.kind} NOT IN ('outbox')`,
				),
			)
			.where(eq(identities.kind, "email"))
			.orderBy(
				asc(identities.id),
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
			),
	);

	const byIdentity = rows.reduce(
		(acc, r) => {
			const id = r.identity.id;

			if (!acc[id]) {
				acc[id] = {
					identity: r.identity,
					mailboxes: [],
				};
			}

			if (r.mailbox) acc[id].mailboxes.push(r.mailbox);
			return acc;
		},
		{} as Record<
			string,
			{
				identity: typeof identities.$inferSelect;
				mailboxes: (typeof mailboxes.$inferSelect)[];
			}
		>,
	);

	return Object.values(byIdentity);
});


export type FetchIdentityMailboxListResult = Awaited<
	ReturnType<typeof fetchIdentityMailboxList>
>;

export const fetchMailboxUnreadCounts = cache(
	async () => {
		const rls = await rlsClient();
		const now = new Date();

		const unreadAgg = await rls((tx) =>
			tx
				.select({
					mailboxId: mailboxThreads.mailboxId,
					unreadThreads: sql<number>`
						count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)
					`,
					unreadTotal: sql<number>`
						coalesce(sum(${mailboxThreads.unreadCount}), 0)
					`,
				})
				.from(mailboxThreads)
				// Sent, Outbox, Drafts, Archive and Trash display no unread counter (lib/folder-unread-counts.ts).
				.innerJoin(
					mailboxes,
					and(
						eq(mailboxes.id, mailboxThreads.mailboxId),
						notInArray(mailboxes.kind, [...NO_UNREAD_COUNT_KINDS]),
					),
				)
				.where(
					// Only unread threads count; without this filter, the RLS policy (EXISTS
					// subquery per row) was evaluated on the whole table: 680 ms on every
					// display for 22,000 threads, against a few ms here.
					and(
						gt(mailboxThreads.unreadCount, 0),
						or(
							isNull(mailboxThreads.snoozedUntil),
							lte(mailboxThreads.snoozedUntil, now)
						),
					)
				)
				.groupBy(mailboxThreads.mailboxId)
		);

		return new Map<
			string,
			{ unreadThreads: number; unreadTotal: number }
		>(
			unreadAgg.map((a) => [
				a.mailboxId,
				{
					unreadThreads: Number(a.unreadThreads ?? 0),
					unreadTotal: Number(a.unreadTotal ?? 0),
				},
			])
		);
	}
);


export type FetchMailboxUnreadCountsResult = Awaited<
	ReturnType<typeof fetchMailboxUnreadCounts>
>;

export const fetchMessageAttachments = cache(async (messageId: string) => {
	const rls = await rlsClient();
	const attachmentsList = await rls((tx) =>
		tx
			.select()
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, messageId))
			.orderBy(desc(messageAttachments.createdAt)),
	);
	return { attachments: attachmentsList };
});

// Stable links, signed at click time by /api/attachments/<id> (lib/attachment-links.ts).
// Only the images referenced by cid: keep an S3 URL: the body of the message is rendered
// apart and must load them without going through the session of the application.
export async function getSignedUrlsForMessage(messageId: string) {
	const { S3_BUCKET } = getServerEnv();
	const rls = await rlsClient();
	const attachments = await rls((tx) =>
		tx
			.select()
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, messageId)),
	);
	const results = await Promise.all(
		attachments.map(async (attachment) => ({
			...attachment,
			...attachmentUrls(attachment),
			inlineUrl: attachment.cid
				? await getSignedUrl(
						s3,
						new GetObjectCommand({ Bucket: S3_BUCKET!, Key: attachment.path! }),
						{ expiresIn: 300 },
					)
				: undefined,
		})),
	);
	return results;
}

export const revalidateMailbox = async (path: string) => {
	// Public action by nature, reserved for signed-in users.
	if (!(await isSignedIn())) return;
	revalidatePath(path);
};

export async function sendMail(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const workspace = await fetchWorkspace()
	if (workspace.isStorageOverLimit){
		return {
			success: false,
			error: "Cannot send mail: Workspace storage limit exceeded.",
		}
	}
	const decodedForm = decode(formData) as any;

	const rls = await rlsClient();
	const identity = await rls(async (tx) => {
		const [identity] = await tx
			.select()
			.from(identities)
			.where(eq(identities.publicId, decodedForm.identityPublicId));
		return identity
	});
	if (!identity) {
		return {
			success: false,
			error: "Identity not found.",
		}
	}
	const boxes = await rls(async (tx) => {
		const resultRows = await tx
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.identityId, identity.id));
		return resultRows;
	});

	const sentMailbox = boxes.find((b) => b.kind === "sent");
	const inboxMailbox = boxes.find((b) => b.kind === "inbox");


	if (!sentMailbox || !inboxMailbox) {
		return {
			success: false,
			error: "Required mailboxes (inbox and sent) not found for the identity.",
		}
	}

	decodedForm.sentMailboxId = sentMailbox.id;
	decodedForm.mailboxId = inboxMailbox.id;
	decodedForm.identityId = identity.id;
	// The user who sends: their address book is the one the worker feeds.
	const sender = await isSignedIn();
	if (!sender?.id) return { success: false, error: "Unauthorized" };
	decodedForm.senderUserId = sender.id;

	// What the form designates only goes to the worker once re-read. Original message:
	// visible to the user, otherwise a reply is refused and a forward goes out without
	// quote or link (as the worker already did for a missing message). Attachments:
	// uploaded by the user or parts of a message of the workspace. Draft: visible to them.
	// Fields reserved to the API and to automatic mails: removed.
	delete decodedForm.apiMessageId;
	delete decodedForm.autoMail;
	if (decodedForm.originalMessageId) {
		const orig = await assertMessageAccess(String(decodedForm.originalMessageId)).catch(() => null);
		if (orig) {
			decodedForm.originalMessageId = orig.id;
		} else if (decodedForm.mode === "reply") {
			return { success: false, error: "Original message not found." };
		} else {
			delete decodedForm.originalMessageId;
		}
	}
	let attachmentList: unknown = [];
	try {
		attachmentList = decodedForm.attachments ? JSON.parse(String(decodedForm.attachments)) : [];
	} catch {
		attachmentList = [];
	}
	for (const a of Array.isArray(attachmentList) ? attachmentList : []) {
		if (!a?.path) continue;
		const ok = await assertOwnedS3Key(String(a.path), sender.id).catch(() => null);
		if (!ok) {
			return {
				success: false,
				error: `Attachment not allowed: ${String(a.filenameOriginal ?? a.path)}. Nothing was sent.`,
			};
		}
	}
	if (decodedForm.draftMessageId) {
		const draftId = await ownedDraftId(String(decodedForm.draftMessageId));
		if (draftId) {
			decodedForm.draftMessageId = draftId;
			// A draft whose send is already pending (undo delay or scheduled) is neither sent a
			// second time nor scheduled again: the send is canceled first.
			if (await pendingSendLive((await draftSendStateOfMessage(draftId)).pendingSend)) {
				return {
					success: false,
					error: "This draft already has a pending send. Cancel it first.",
				};
			}
		} else delete decodedForm.draftMessageId;
	}

	if (toArray(decodedForm.to as any).length === 0) {
		return {
			success: false,
			error: "Please provide at least one recipient in the To field.",
		};
	}
	// A recipient without an address ("dev") used to be silently ignored on send.
	const badRecipients = (["to", "cc", "bcc"] as const)
		.flatMap((f) => toArray(decodedForm[f] as any))
		.filter((a) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a.replace(/^.*<([^<>]*)>\s*$/, "$1").trim()));
	if (badRecipients.length) {
		return {
			success: false,
			error: `Not an email address: ${badRecipients.join(", ")}. Nothing was sent.`,
		};
	}

	const scheduledAtRaw = decodedForm.scheduledAt
		? String(decodedForm.scheduledAt)
		: "";
	let origin: "scheduled" | "undo" = "undo";
	let sendAt = new Date();
	if (scheduledAtRaw) {
		// A time more than one minute in the past is refused (the mail would leave right away,
		// which the user did not ask for).
		const check = validateScheduledAt(scheduledAtRaw);
		if (!check.ok) {
			return {
				success: false,
				error:
					check.reason === "past"
						? "The scheduled send time has already passed. Choose a time in the future."
						: "Invalid scheduled send time.",
			};
		}

		origin = "scheduled";
		sendAt = check.at;
	}

	// Outbox. Every send from the interface is a draft_messages ledger row, then the draft
	// mark, then a job with the same id (packages/common/src/outbox.ts): scheduled at the chosen
	// time, or delayed by the undo delay chosen by the user (Settings > Compose, 0 = send
	// immediately). "Undo" and "Send now" go through the row; server-side, so closing the tab
	// does not prevent the send.
	const undoMs = origin === "undo" ? (await undoSendSeconds()) * 1000 : 0;
	if (origin === "undo") sendAt = new Date(Date.now() + undoMs);
	const imapDraftId = decodedForm.draftMessageId ? String(decodedForm.draftMessageId) : null;
	const { sendMailQueue } = await getRedis();
	const queued = await enqueueSend(
		{
			payload: decodedForm,
			identityId: identity.id,
			mailboxId: String(decodedForm.mailboxId),
			origin,
			sendAt,
			fromAddress: identity.value,
		},
		{
			insertRow: async (v) => {
				const values = DraftMessageInsertSchema.parse(v);
				const [created] = await rls((tx) =>
					tx
						.insert(draftMessages)
						.values(values)
						.returning({ id: draftMessages.id, scheduledAt: draftMessages.scheduledAt }),
				);
				if (!created?.id) throw new Error("send row not created");
				return created;
			},
			// The source draft carries the send mark (Outbox section, the banner replaces the
			// editor when opened, no change silently lost). A scheduled send is not created
			// without a mark; a delayed send leaves even without one.
			mark: async (row) =>
				origin === "scheduled"
					? markDraftScheduled(imapDraftId, scheduledPendingSend(row))
					: (await markDraftPending(imapDraftId ?? "", row.id, undoMs), true),
			unmark: async () => {
				const id = imapDraftId ? await ownedDraftId(imapDraftId) : null;
				if (id) await setDraftSendState(id, { pendingSend: null });
			},
			addJob: (name, data, opts) => sendMailQueue.add(name, data, opts),
			deleteRow: (id) =>
				rls((tx) =>
					tx
						.delete(draftMessages)
						.where(and(eq(draftMessages.id, id), eq(draftMessages.status, "scheduled"))),
				),
			cancelRow: (id) =>
				rls((tx) =>
					tx
						.update(draftMessages)
						.set({ status: "canceled", updatedAt: new Date() })
						.where(and(eq(draftMessages.id, id), eq(draftMessages.status, "scheduled"))),
				),
			supersede: (draftId) => supersedeFailedSends(draftId),
			interrupted: (draftId) => interruptedSendOf(draftId, identity.id),
		},
	).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e), maybeSent: false }));
	if (!queued.ok) {
		// Previous send interrupted (may have been sent): say so, nothing was queued.
		if (queued.maybeSent) return { success: false, error: queued.error };
		console.error("[send] enqueue failed", queued.error);
		return {
			success: false,
			error: origin === "scheduled" ? "Failed to schedule your mail." : "Failed to send your mail. Nothing was sent.",
		};
	}
	revalidatePath("/dashboard/mail");
	if (origin === "scheduled") {
		return {
			success: true,
			message: "Message scheduled",
			data: { draftMessageId: queued.rowId, scheduledAt: queued.scheduledAt.toISOString() },
		};
	}
	return {
		success: true,
		message: "Message sent",
		data: { pendingSendId: queued.rowId, undoMs },
	};
}

// A new send of a draft dismisses its previous failed sends from the Outbox (otherwise "Retry"
// on the old one would send a second time). Never an interrupted send (may have been sent):
// it is the only trace, the user dismisses it. RLS.
async function supersedeFailedSends(imapDraftId: string) {
	const rls = await rlsClient();
	await rls((tx) =>
		tx
			.update(draftMessages)
			.set({ dismissedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(draftMessages.status, "failed"),
					eq(draftMessages.acceptanceUnknown, false),
					isNull(draftMessages.dismissedAt),
					sql`${draftMessages.payload}->>'draftMessageId' = ${imapDraftId}`,
				),
			),
	);
}

// The draft is only touched if it is visible to the user: RLS and sending identity of the
// folder (join mailboxes -> identities, like assertMessageAccess).
async function ownedDraftId(draftMessageId: string) {
	if (!isUuid(draftMessageId)) return null;
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ id: messages.id })
			.from(messages)
			.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
			.innerJoin(identities, eq(mailboxes.identityId, identities.id))
			.where(and(eq(messages.id, draftMessageId), eq(messages.draft, true)))
			.limit(1),
	);
	return row?.id ?? null;
}

// Send state (meta.draft) of a draft already checked by ownedDraftId.
async function draftSendStateOfMessage(draftId: string) {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ metaData: messages.metaData })
			.from(messages)
			.where(eq(messages.id, draftId))
			.limit(1),
	);
	return draftSendStateOf((row?.metaData as any)?.draft ?? null);
}

async function markDraftPending(
	draftMessageId: string,
	jobId: string,
	delayMs: number,
) {
	try {
		const id = await ownedDraftId(draftMessageId);
		if (!id) return;
		await setDraftSendState(id, {
			pendingSend: {
				jobId,
				sendAt: new Date(Date.now() + delayMs).toISOString(),
			},
			sendError: null,
		});
	} catch (e) {
		console.error("[send] pendingSend mark failed", e);
	}
}

// Scheduled send: same mark, set with the chosen time (jobId = draft_messages row). False if the
// mark could not be set (the caller then removes the job and the row); true as well when there
// is no source draft (message written without a saved draft).
async function markDraftScheduled(
	draftMessageId: string | null,
	pendingSend: { jobId: string; sendAt: string },
) {
	if (!draftMessageId) return true;
	try {
		const id = await ownedDraftId(String(draftMessageId));
		if (!id) return false;
		await setDraftSendState(id, { pendingSend, sendError: null });
		return true;
	} catch (e) {
		console.error("[send] scheduled mark failed", e);
		return false;
	}
}

// A pending send is only touched if its sending identity is visible to the user (RLS);
// otherwise everything behaves as if the job did not exist.
async function ownedPendingSend(pendingSendId: string) {
	if (!pendingSendId) return null;
	await assertSignedIn();
	const { sendMailQueue } = await getRedis();
	const job = await sendMailQueue.getJob(String(pendingSendId));
	if (!job) return null;
	const identityId = String((job.data as any)?.identityId ?? "");
	const visible = await assertIdentityAccess({ id: identityId }).catch(() => null);
	return visible ? job : null;
}

// draft_messages row of a scheduled send, as seen by the user: RLS (workspace) and visible
// sending identity (the RLS of a workspace sees all its rows). Null otherwise.
async function scheduledRowOf(rowId: string) {
	if (!isUuid(rowId)) return null;
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({
				id: draftMessages.id,
				identityId: draftMessages.identityId,
				status: draftMessages.status,
				origin: draftMessages.origin,
				scheduledAt: draftMessages.scheduledAt,
				payload: draftMessages.payload,
			})
			.from(draftMessages)
			.where(eq(draftMessages.id, rowId))
			.limit(1),
	);
	if (!row?.identityId) return null;
	const identity = await assertIdentityAccess({ id: row.identityId }).catch(() => null);
	return identity ? { ...row, identity } : null;
}

// Cancel of a scheduled send: the draft_messages row goes from "scheduled" to "canceled" in a
// single conditional UPDATE (RLS), which settles the race with the worker (it only claims
// "scheduled"), then the job is removed. Null if the send has already left or is in progress.
async function cancelScheduledRow(rowId: string) {
	const seen = await scheduledRowOf(rowId);
	if (!seen) return null;
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.update(draftMessages)
			.set({ status: "canceled", updatedAt: new Date() })
			.where(and(eq(draftMessages.id, rowId), eq(draftMessages.status, "scheduled")))
			.returning({ id: draftMessages.id, payload: draftMessages.payload }),
	);
	if (!row) return null;
	try {
		const { sendMailQueue } = await getRedis();
		await (await sendMailQueue.getJob(rowId))?.remove();
	} catch {
		// Job already taken: it will do nothing, the row is no longer "scheduled".
	}
	return { ...row, identity: seen.identity };
}

// The content of a canceled scheduled send (draft_messages row) goes back into the IMAP draft:
// nothing typed is lost, even if the source draft was changed or deleted in the meantime. The
// send mark is cleared first (otherwise the guard refuses the save). With onlyIfMissing, an
// existing draft is left as is (only its mark is cleared) and only a missing draft is
// recreated.
async function restoreDraftFromRow(
	row: { payload: Record<string, any>; identity: Record<string, any> },
	opts: { onlyIfMissing?: boolean } = {},
) {
	const p = row.payload ?? {};
	const existing = await ownedDraftId(String(p.draftMessageId ?? ""));
	if (existing) {
		await setDraftSendState(existing, { pendingSend: null });
		if (opts.onlyIfMissing) return existing;
	}
	const saved = await saveDraft({
		identityPublicId: String(row.identity.publicId),
		draftMessageId: existing,
		to: p.to,
		cc: p.cc,
		bcc: p.bcc,
		subject: p.subject,
		html: p.html,
		text: p.text,
		mode: p.mode,
		originalMessageId: p.originalMessageId,
		attachments: p.attachments,
		includeSignature: p.includeSignature,
		quoteScope: p.quoteScope,
		quoteMode: p.quoteMode,
		quoteHtml: p.quoteHtml,
	});
	if (saved.error) throw new Error(saved.error);
	return saved.draftMessageId;
}

// "Undo" of a send still pending. A send tracked by its draft_messages row (jobId = row id:
// undo delay, scheduled send) is canceled through the row: CAS scheduled -> canceled before
// any job removal and any draft restore (cancelSend); if lost, the real state is returned
// (already sent, being sent). A legacy delayed "undo-send-*" job (in flight during an
// upgrade) is removed while it waits.
export async function cancelPendingSend(pendingSendId: string) {
	const id = String(pendingSendId);
	try {
		const seen = await scheduledRowOf(id);
		if (seen) {
			const rls = await rlsClient();
			const res = await cancelSend({
				casCancel: async () => {
					const [row] = await rls((tx) =>
						tx
							.update(draftMessages)
							.set({ status: "canceled", updatedAt: new Date() })
							.where(and(eq(draftMessages.id, id), eq(draftMessages.status, "scheduled")))
							.returning({ id: draftMessages.id }),
					);
					return row ?? null;
				},
				readRow: () => ledgerStateRowOf(id),
				removeJob: async () => {
					const { sendMailQueue } = await getRedis();
					await (await sendMailQueue.getJob(id))?.remove();
				},
				// Undo delay: the draft stayed in place, only its mark is removed (recreated from
				// the row if it is gone). Scheduled send: the content sent goes back into the
				// draft.
				restore: () => restoreDraftFromRow(seen, { onlyIfMissing: seen.origin === "undo" }),
				unlock: () => unlockDraftOfRow(seen),
				settle: (action) => settleDraftOfRow(seen, action),
			});
			return { cancelled: res.cancelled, state: res.state };
		}
		const job = await ownedPendingSend(id);
		if (!job || job.name === SCHEDULED_JOB) return { cancelled: false as const, state: null };
		if ((await job.getState()) !== "delayed") return { cancelled: false as const, state: null };
		await job.remove();
		try {
			const draftId = await ownedDraftId(imapDraftIdOfJob(job.name, job.data));
			if (draftId) await setDraftSendState(draftId, { pendingSend: null });
		} catch (e) {
			console.error("[send] pendingSend clear failed", e);
		}
		return { cancelled: true as const, state: "canceled" as const };
	} catch (e) {
		console.error("[send] cancel failed", e);
		return { cancelled: false as const, state: null };
	}
}

// State of a ledger row already checked by scheduledRowOf.
async function ledgerStateRowOf(rowId: string) {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({
				status: draftMessages.status,
				deliveryState: draftMessages.deliveryState,
				acceptanceUnknown: draftMessages.acceptanceUnknown,
				acceptedAt: draftMessages.acceptedAt,
				dismissedAt: draftMessages.dismissedAt,
				sentRowId: draftMessages.sentRowId,
			})
			.from(draftMessages)
			.where(eq(draftMessages.id, rowId))
			.limit(1),
	);
	return row ?? null;
}

// Row already canceled (second click): the draft mark is only removed if it still points to
// this row; the content is not touched.
async function unlockDraftOfRow(row: { id: string; payload: Record<string, any> }) {
	const draftId = await ownedDraftId(String(row.payload?.draftMessageId ?? ""));
	if (!draftId) return;
	if ((await draftSendStateOfMessage(draftId)).pendingSend?.jobId !== row.id) return;
	await setDraftSendState(draftId, { pendingSend: null }, { ifJobId: row.id });
}

// Cancel on a finished row whose draft still carries the mark (cancelSend): sent with its Sent
// copy, the draft is deleted as after a send; otherwise only the mark is removed.
async function settleDraftOfRow(
	row: { id: string; payload: Record<string, any>; identity: Record<string, any> },
	action: SettleAction,
) {
	if (action === "unlock") return unlockDraftOfRow(row);
	const draftId = await ownedDraftId(String(row.payload?.draftMessageId ?? ""));
	if (!draftId) return;
	const ref = await deleteDraftRow({
		ownerId: String(row.identity.ownerId),
		draftMessageId: draftId,
		afterSend: true,
		ifJobId: row.id,
	});
	if (!ref) return;
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(DRAFT_DELETE_JOB, ref, draftDeleteJobOptions());
}

// "Send now": the pending job goes out immediately. The mark (sendAt = now) is only set once the
// job is promoted or added again: a failure does not suggest a send that left. Redis job gone or
// finished while the row still waits: added again without delay from the row (sendNowPlanOf).
export async function sendPendingNow(pendingSendId: string) {
	const job = await ownedPendingSend(pendingSendId);
	try {
		let imapDraftId = "";
		const row = await scheduledRowOf(String(pendingSendId));
		const plan = sendNowPlanOf(job ? await job.getState() : null, row?.status ?? null);
		if (plan === "promote" && job) {
			await job.promote();
			imapDraftId = imapDraftIdOfJob(job.name, job.data);
		} else if (plan === "readd" && row) {
			// Job finished (failed, completed) while the row still waits: removed, otherwise BullMQ
			// would ignore the add with the same id.
			if (job) await job.remove();
			const re = scheduledJobOf({ ...row, scheduledAt: new Date() });
			const { sendMailQueue } = await getRedis();
			await sendMailQueue.add(re.name, re.data, { ...re.opts, delay: 0 });
			imapDraftId = re.data.imapDraftId ?? "";
		} else return;
		const id = await ownedDraftId(imapDraftId);
		if (id)
			await setDraftSendState(id, {
				pendingSend: { jobId: pendingSendId, sendAt: new Date().toISOString() },
			});
	} catch {
		// already sent
	}
}

// Send result, called once the delay has elapsed (or after "Send now") to display a
// possible error. Never during the delay: the server actions of a tab run one at a time,
// waiting here would block all the others.
export async function waitPendingSend(pendingSendId: string): Promise<FormState> {
	const job = await ownedPendingSend(pendingSendId);
	if (job) {
		const { sendMailEvents } = await getRedis();
		try {
			return (await job.waitUntilFinished(sendMailEvents, 120_000)) ?? {};
		} catch (e: any) {
			return { error: e?.message ?? "Sending failed" };
		}
	}
	// Job already removed from Redis: the outcome is on the ledger row (Outbox).
	const row = await scheduledRowOf(String(pendingSendId));
	if (row?.status === "failed") return { error: String(row.payload?.__error ?? "Sending failed") };
	return {};
}

export const deltaFetch = async ({ identityId: requestedId }: { identityId: string }) => {
	const { id: identityId } = await assertIdentityAccess({ id: requestedId });
	const { smtpQueue, smtpEvents } = await getRedis();
	const job = await smtpQueue.add(
		"delta-fetch",
		{ identityId },
		{
			jobId: `delta-fetch-${identityId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
	await job.waitUntilFinished(smtpEvents);
};


export const initSearch = async (
	query: string,
	workspacePublicId: string,
	identityPublicId: string,
	mailboxSlug: string,
	hasAttachment: boolean,
	onlyUnread: boolean,
	starred: boolean,
	page: number,
): Promise<SearchThreadsResponse> => {
	const q = query.trim();
	if (!q) {
		return { items: [], totalThreads: 0, totalMessages: 0 };
	}

	// Identity and workspace of the filter re-read by RLS, never those of the client (it
	// could search any mailbox). The mailbox stays that of the page; a slug
	// (encodeURIComponent or slugify) never contains these characters, which would allow
	// escaping the value of the Typesense filter.
	const identity = await assertIdentityAccess({ publicId: identityPublicId });
	const workspace = await fetchWorkspace();
	if (!workspace || workspace.id !== identity.workspaceId) {
		throw new Error("Identity not found or access denied");
	}
	if (/["`\\&|]/.test(String(mailboxSlug ?? ""))) {
		return { items: [], totalThreads: 0, totalMessages: 0 };
	}

	const client = getTypeSenseClient();

	const filters = [
		`workspacePublicId:=${JSON.stringify(workspace.publicId)}`,
		`identityPublicId:=${JSON.stringify(identity.publicId)}`,
		`mailboxSlug:=${JSON.stringify(String(mailboxSlug ?? ""))}`,
	];

	if (hasAttachment) filters.push("hasAttachment:=1");
	if (onlyUnread) filters.push("unread:=1");
	if (starred) filters.push("starred:=1");

	const result = (await client.collections("messages").documents().search({
		q,
		// fromDomain is queried, otherwise a bare domain ("example.com") finds nothing:
		// Typesense strips symbols and indexes "x-y@example.com" as a single word.
		query_by: "subject,snippet,fromName,fromEmail,fromDomain,participants",
		filter_by: filters.join(" && "),
		sort_by: "createdAt:desc",
		group_by: "threadId",
		group_limit: 1,
		per_page: PAGE_SIZE,
		page,
	})) as any;

	const groups = result?.grouped_hits as
		| Array<{ group_key: string[]; hits: Array<{ document: any }> }>
		| undefined;

	const sourceHits = groups?.length
		? groups.map((g) => g.hits[0]?.document ?? {})
		: (result?.hits ?? []).map((h: any) => h.document ?? {});

	return {
		items: sourceHits.map((d: any) => ({
			id: d.id ?? "",
			threadId: d.threadId ?? "",
			subject: d.subject ?? null,
			snippet: (d.snippet ?? d.text ?? "").slice(0, 200),
			fromName: d.fromName ?? null,
			fromEmail: d.fromEmail ?? null,
			participants: Array.isArray(d.participants) ? d.participants : [],
			labels: Array.isArray(d.labels) ? d.labels : [],
			hasAttachment: Number(d.hasAttachment) === 1,
			unread: Number(d.unread) === 1,
			starred: Number(d.starred) === 1,
			createdAt: d.createdAt ?? 0,
			lastInThreadAt: d.lastInThreadAt ?? d.createdAt ?? 0,
		})),
		totalThreads: result?.found ?? sourceHits.length,
		totalMessages: result?.found_docs ?? sourceHits.length,
	};
};




export const fetchWebMailThreadDetail = cache(async (threadId: string) => {
	const rls = await rlsClient();
	const result = await rls(async (tx) => {
		const rows = await tx
			.select({
				thread: threads,
				message: messages,
			})
			.from(threads)
			.innerJoin(messages, eq(messages.threadId, threads.id))
			.where(eq(threads.id, threadId))
			.orderBy(asc(sql`coalesce(${messages.date}, ${messages.createdAt})`));

		if (rows.length === 0) {
			return {
				thread: null,
				messages: [] as (typeof rows)[number]["message"][],
			};
		}

		const thread = rows[0].thread;
		const msgs = rows.map((r) => r.message);
		return { thread, messages: msgs };
	});
	return result;
});

export const markAsRead = cache(
	async (
		threadIds: string | string[],
		mailboxId: string,
		markSmtp: boolean,
		refresh = true,
	) => {
		const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
			.map(String)
			.filter(Boolean);

		if (!requestedIds.length || !mailboxId) return;

		// Visible mailbox and threads of that mailbox only.
		const { threadIds: ids } = await assertThreadsInMailbox(mailboxId, requestedIds);
		if (!ids.length) return;

		const now = new Date();
		const rls = await rlsClient();

		await rls(async (tx) => {
			await tx
				.update(messages)
				.set({ seen: true, updatedAt: now })
				.where(
					and(
						inArray(messages.threadId, ids),
						eq(messages.mailboxId, mailboxId),
					),
				);

			await tx
				.update(mailboxThreads)
				.set({ unreadCount: 0, updatedAt: now })
				.where(
					and(
						inArray(mailboxThreads.threadId, ids),
						eq(mailboxThreads.mailboxId, mailboxId),
					),
				);
		});

		if (refresh) {
			revalidatePath("/dashboard/mail");
		}

		if (markSmtp) {
			const { smtpQueue, searchIngestQueue } = await getRedis();

			await Promise.all(
				ids.map((threadId) =>
					smtpQueue.add(
						"mail:set-flags",
						{ threadId, mailboxId, op: "read" },
						{
							attempts: 3,
							backoff: { type: "exponential", delay: 1500 },
							removeOnComplete: true,
							removeOnFail: false,
						},
					),
				),
			);

			await Promise.all(
				ids.map((threadId) =>
					searchIngestQueue.add(
						"refresh-thread",
						{ threadId },
						{
							jobId: `refresh-${threadId}`,
							removeOnComplete: true,
							removeOnFail: false,
							attempts: 3,
							backoff: { type: "exponential", delay: 1500 },
						},
					),
				),
			);
		}
	},
);

export const markAsUnread = async (
	threadIds: string | string[],
	mailboxId: string,
	markSmtp: boolean,
	refresh: boolean,
) => {
	const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);

	if (!requestedIds.length || !mailboxId) return;

	// Visible mailbox and threads of that mailbox only.
	const { threadIds: ids } = await assertThreadsInMailbox(mailboxId, requestedIds);
	if (!ids.length) return;

	const now = new Date();
	const rls = await rlsClient();

	await rls(async (tx) => {
		await tx
			.update(messages)
			.set({ seen: false, updatedAt: now })
			.where(
				and(inArray(messages.threadId, ids), eq(messages.mailboxId, mailboxId)),
			);

		const grouped = await tx
			.select({
				threadId: messages.threadId,
				count: sql<number>`count(*)`,
			})
			.from(messages)
			.where(
				and(
					inArray(messages.threadId, ids),
					eq(messages.mailboxId, mailboxId),
					eq(messages.seen, false),
				),
			)
			.groupBy(messages.threadId);

		const countMap = new Map<string, number>();
		for (const g of grouped) countMap.set(String(g.threadId), Number(g.count));

		for (const tid of ids) {
			const unread = countMap.get(tid);
			await tx
				.update(mailboxThreads)
				.set({
					unreadCount: unread ?? 1, // fallback to 1 so it surfaces in UI if uncertain
					updatedAt: now,
				})
				.where(
					and(
						eq(mailboxThreads.threadId, tid),
						eq(mailboxThreads.mailboxId, mailboxId),
					),
				);
		}
	});

	if (refresh) {
		revalidatePath("/mail");
	}

	if (markSmtp) {
		const { smtpQueue, searchIngestQueue } = await getRedis();

		await Promise.all(
			ids.map((threadId) =>
				smtpQueue.add(
					"mail:set-flags",
					{ threadId, mailboxId, op: "unread" },
					{
						attempts: 3,
						backoff: { type: "exponential", delay: 1500 },
						removeOnComplete: true,
						removeOnFail: false,
					},
				),
			),
		);

		await Promise.all(
			ids.map((threadId) =>
				searchIngestQueue.add(
					"refresh-thread",
					{ threadId },
					{
						jobId: `refresh-${threadId}`,
						removeOnComplete: true,
						removeOnFail: false,
						attempts: 3,
						backoff: { type: "exponential", delay: 1500 },
					},
				),
			),
		);
	}
};

// Message (message-level move) present in the mailbox.
async function messageInMailbox(messageId: string, mailboxId: string) {
	if (!isUuid(messageId)) return false;
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ id: messages.id })
			.from(messages)
			.where(and(eq(messages.id, String(messageId)), eq(messages.mailboxId, mailboxId)))
			.limit(1),
	);
	return !!row;
}

// Moves and deletions are done by the worker. Revalidating right after the job was
// posted redrew the list BEFORE the database update: the toast said "moved to Trash" and
// the thread stayed displayed. So we wait for the threads to have left the mailbox (a few
// tens of ms normally), with a ceiling so the action never blocks.
const waitForThreadsToLeave = async (
	threadIds: string[],
	mailboxId: string,
	timeoutMs = 5000,
) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [row] = await db
			.select({ n: count() })
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.mailboxId, mailboxId),
					inArray(mailboxThreads.threadId, threadIds),
				),
			);
		if (!Number(row?.n ?? 0)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
};

// A mailbox synchronised over IMAP is always moved on the server, whatever the page
// loaded. Search and label views do not have the synchronisation state of the mailbox: they
// sent moveImap=false and the trash ran "database only" (database and IMAP diverged). The
// worker applies the same rule (moveMail); here it also holds for the creation of the
// Archive mailbox and for permanent deletion.
const imapSynced = async (mailboxId: string) =>
	(
		await db
			.select({ id: mailboxSync.id })
			.from(mailboxSync)
			.where(eq(mailboxSync.mailboxId, mailboxId))
			.limit(1)
	).length > 0;

export const moveToTrash = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
	messageId?: string,
) => {
	const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);

	if (!requestedIds.length || !mailboxId) return;

	// Visible mailbox and threads of that mailbox only; a given message (messageId) must
	// be in this mailbox, otherwise the worker would have moved nothing.
	const { mailbox: source, threadIds: ids } = await assertThreadsInMailbox(mailboxId, requestedIds);
	moveImap = shouldMoveImap(moveImap, await imapSynced(source.id));

	// From the trash, "delete" cannot be a move to the trash (the job did nothing and the
	// interface announced "moved to Trash"): it is a permanent deletion, like the button of
	// the list header.
	if (source.kind === "trash") {
		await deleteForever(ids, source.id, moveImap, refresh);
		return "deleted" as const;
	}
	if (!ids.length || (messageId && !(await messageInMailbox(messageId, source.id)))) {
		return "trashed" as const;
	}

	const { smtpQueue, searchIngestQueue } = await getRedis();

	// A single job for the whole selection (see moveMail, worker): one job per thread,
	// processed one by one with its own IMAP round trip, made the selection disappear one
	// thread at a time.
	await smtpQueue.add(
		"mail:move",
		{ threadId: ids[0], threadIds: ids, mailboxId: source.id, op: "trash", messageId, moveImap },
		{
			// The worker fails the job when the IMAP server did not move the messages (put
			// back in the source in the database); 8 attempts spaced 5 s, 10 s, 20 s...
			// cover a restart of the mail server (3 attempts in 4.5 s were not enough).
			attempts: 8,
			backoff: { type: "exponential", delay: 5000 },
			removeOnComplete: true,
			removeOnFail: false,
		},
	);

	await Promise.all(
		ids.map((threadId) =>
			searchIngestQueue.add(
				"refresh-thread",
				{ threadId },
				{
					jobId: `refresh-${threadId}`,
					removeOnComplete: true,
					removeOnFail: false,
					attempts: 3,
					backoff: { type: "exponential", delay: 1500 },
				},
			),
		),
	);

	if (refresh) {
		await waitForThreadsToLeave(ids, mailboxId);
		revalidatePath("/mail");
	}
	return "trashed" as const;
};

// Archive = move to the "archive" kind mailbox of the identity. The worker
// (mail:move, op=archive) looks it up by kind; if it does not exist yet for
// this identity (Stalwart does not create one), it is created first, on the IMAP side
// when the mailbox is synchronised.
// expiresAt (ISO, optional) = archive for a chosen duration. Never written here: it travels in
// the mail:move job, whose moveMail sets it on the destination row inside the move's transaction
// (the asynchronous move and the expiry cannot diverge). Invalid, past or more than 10 years
// away: plain archive.
export const archiveThread = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
	expiresAt?: string | null,
) => {
	const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);
	if (!requestedIds.length || !mailboxId) return;

	// Visible mailbox and threads of that mailbox only.
	const { mailbox: src, threadIds: ids } = await assertThreadsInMailbox(mailboxId, requestedIds);
	if (!ids.length) return;
	if (src.kind === "archive") return;
	moveImap = shouldMoveImap(moveImap, await imapSynced(src.id));
	const expiry = parseExpiry(expiresAt, new Date());

	const findArchive = async () => {
		const [row] = await db
			.select()
			.from(mailboxes)
			.where(
				and(eq(mailboxes.identityId, src.identityId), eq(mailboxes.kind, "archive")),
			)
			.limit(1);
		return row;
	};

	const { smtpQueue, smtpEvents, searchIngestQueue } = await getRedis();

	if (!(await findArchive())) {
		if (moveImap) {
			const job = await smtpQueue.add(
				"mailbox:add-new",
				{
					name: "Archive",
					parentId: null,
					identityId: src.identityId,
					ownerId: src.ownerId,
					kind: "archive",
					slug: "archive",
				},
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
		if (!(await findArchive())) {
			throw new Error("Archive folder could not be created");
		}
	}

	// A single job for the whole selection (see moveMail, worker): one job per thread,
	// processed one by one with its own IMAP round trip, made the selection disappear one
	// thread at a time.
	await smtpQueue.add(
		"mail:move",
		{
			threadId: ids[0],
			threadIds: ids,
			mailboxId: src.id,
			op: "archive",
			moveImap,
			expiresAt: expiry ? expiry.toISOString() : null,
		},
		{
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
			removeOnComplete: true,
			removeOnFail: false,
		},
	);

	await Promise.all(
		ids.map((threadId) =>
			searchIngestQueue.add(
				"refresh-thread",
				{ threadId },
				{
					jobId: `refresh-${threadId}`,
					removeOnComplete: true,
					removeOnFail: false,
					attempts: 3,
					backoff: { type: "exponential", delay: 1500 },
				},
			),
		),
	);

	if (refresh) {
		await waitForThreadsToLeave(ids, mailboxId);
		revalidatePath("/mail");
	}
};

export const toggleStar = async (
	requestedThreadId: string,
	requestedMailboxId: string,
	starred: boolean,
	starImap: boolean,
) => {
	if (!requestedThreadId || !requestedMailboxId) return;
	// Visible mailbox and thread of that mailbox only.
	const {
		mailbox: { id: mailboxId },
		threadIds: [threadId],
	} = await assertThreadsInMailbox(requestedMailboxId, [requestedThreadId]);
	if (!threadId) return;
	const { smtpQueue, searchIngestQueue } = await getRedis();

	if (starImap) {
		await smtpQueue.add(
			"mail:set-flags",
			{
				threadId,
				mailboxId,
				op: starred ? "unflag" : "flag",
			},
			{
				attempts: 3,
				backoff: { type: "exponential", delay: 1500 },
				removeOnComplete: true,
				removeOnFail: true,
			},
		);
	} else {
		const rls = await rlsClient();
		const op = starred ? "unflag" : "flag";
		await rls(async (tx) => {
			const update: Record<string, any> = { updatedAt: new Date() };
			if (op === "flag") update.flagged = true;
			if (op === "unflag") update.flagged = false;

			await tx
				.update(messages)
				.set(update)
				.where(
					and(
						eq(messages.threadId, threadId),
						eq(messages.mailboxId, mailboxId),
					),
				);

			const [agg] = await tx
				.select({
					unreadCount: sql<number>`count(*) filter (where
					${messages.seen}
					=
					false
					)`,
					anyFlagged: sql<boolean>`bool_or
					(
					${messages.flagged}
					)`,
				})
				.from(messages)
				.where(
					and(
						eq(messages.threadId, threadId),
						eq(messages.mailboxId, mailboxId),
					),
				);

			await tx
				.update(mailboxThreads)
				.set({
					unreadCount: agg.unreadCount ?? 0,
					starred: agg.anyFlagged ?? false,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(mailboxThreads.threadId, threadId),
						eq(mailboxThreads.mailboxId, mailboxId),
					),
				);
		});
	}

	await searchIngestQueue.add(
		"refresh-thread",
		{ threadId: threadId },
		{
			jobId: `refresh-${threadId}`,
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);

	revalidatePath("/mail");
};

export const fetchMailboxThreads = async (
	identityPublicId: string,
	mailboxSlug: string,
	page: number,
) => {
	const rls = await rlsClient();
	const now = new Date();
	const safePage = page && page > 0 ? page : 1;

	const effectiveActivityAt = sql`
		COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt})
	`;

	const rows = await rls((tx) =>
		tx
			.select({ thread: mailboxThreads })
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.identityPublicId, identityPublicId),
					eq(mailboxThreads.mailboxSlug, mailboxSlug),
					or(
						isNull(mailboxThreads.snoozedUntil),
						lte(mailboxThreads.snoozedUntil, now),
					),
				),
			)
			.orderBy(
				desc(effectiveActivityAt),
				desc(mailboxThreads.lastActivityAt),
				desc(mailboxThreads.threadId),
			)
			.offset((safePage - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
	);

	// Send state of the page drafts (sending, failure), read from meta.draft of the rows
	// of the mailbox; only the threads concerned carry `draftSend`.
	// Each thread that contains a draft also carries `draftTimes` (creation and last
	// edit), displayed in the Drafts mailbox (its slug follows the name of the IMAP mailbox).
	const threadRows = rows.map(
		(r) =>
			r.thread as typeof r.thread & {
				draftSend?: DraftSendState;
				draftTimes?: DraftTimes;
			},
	);
	{
		const ids = threadRows.map((t) => String(t.threadId));
		if (ids.length) {
			const drafts = await rls((tx) =>
				tx
					.select({
						threadId: messages.threadId,
						meta: sql<any>`${messages.metaData} -> 'draft'`,
						createdAt: messages.createdAt,
						updatedAt: messages.updatedAt,
						date: messages.date,
					})
					.from(messages)
					.where(
						and(
							eq(messages.draft, true),
							inArray(messages.threadId, ids),
						),
					),
			);
			for (const d of drafts) {
				const t = threadRows.find((x) => String(x.threadId) === String(d.threadId));
				if (!t) continue;
				const state = draftSendStateOf(d.meta);
				// A send in progress takes precedence over an older error of the same thread.
				if ((state.pendingSend || state.sendError) && (!t.draftSend || state.pendingSend))
					t.draftSend = state;
				const times = draftTimesOf({ ...d, metaData: { draft: d.meta } });
				// Several drafts in a thread: the most recently edited.
				if (!t.draftTimes || String(times.savedAt) > String(t.draftTimes.savedAt))
					t.draftTimes = times;
			}
		}
	}
	return threadRows;
};

export type FetchMailboxThreadsResult = Awaited<
	ReturnType<typeof fetchMailboxThreads>
>;

export type FetchMailboxThreadsByIdsResult = {
	threads: (typeof mailboxThreads.$inferSelect)[];
	missing?: string[];
};

export async function fetchMailboxThreadsList(
	mailboxId: string,
	threadIds: string[],
): Promise<FetchMailboxThreadsByIdsResult> {
	if (!threadIds?.length) return { threads: [] };

	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select()
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.mailboxId, mailboxId),
					inArray(mailboxThreads.threadId, threadIds),
				),
			),
	);

	const rank = new Map(threadIds.map((id, i) => [id, i]));
	rows.sort(
		(a, b) =>
			(rank.get(a.threadId) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.threadId) ?? Number.MAX_SAFE_INTEGER),
	);

	const found = new Set(rows.map((r) => r.threadId));
	const missing = threadIds.filter((id) => !found.has(id));

	return { threads: rows, missing };
}

export async function deleteForever(
	threadIds: string | string[] | null,
	mailboxId: string,
	imapDelete: boolean,
	refresh = true,
	opts?: { emptyAll?: boolean },
) {
	const { emptyAll = false } = opts ?? {};

	// Access control taken from upstream (CWE-306): signed-in user, mailbox visible to
	// them (RLS), threads of this mailbox only.
	const user = await isSignedIn();
	if (!user?.id) throw new Error("Unauthorized");
	if (!mailboxId) throw new Error("Mailbox is required");

	const rls = await rlsClient();
	const [allowedMailbox] = await rls((tx) =>
		tx
			.select({ id: mailboxes.id })
			.from(mailboxes)
			.innerJoin(identities, eq(mailboxes.identityId, identities.id))
			.where(eq(mailboxes.id, mailboxId))
			.limit(1),
	);
	if (!allowedMailbox) throw new Error("Mailbox not found or access denied");

	const { smtpQueue, searchIngestQueue } = await getRedis();

	if (emptyAll) {
		await smtpQueue.add(
			"mail:delete-permanent",
			{ mailboxId: allowedMailbox.id, emptyAll: true, imapDelete },
			{
				attempts: 3,
				backoff: { type: "exponential", delay: 1500 },
				removeOnComplete: true,
				removeOnFail: true,
			},
		);
		if (refresh) revalidatePath("/mail");
		return;
	}

	const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.filter(Boolean)
		.map(String);

	if (!requestedIds.length) return;

	const allowedThreads = await rls((tx) =>
		tx
			.select({ threadId: mailboxThreads.threadId })
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.mailboxId, allowedMailbox.id),
					inArray(mailboxThreads.threadId, requestedIds),
				),
			),
	);
	const ids = allowedThreads.map((row) => String(row.threadId));
	if (ids.length !== requestedIds.length) {
		throw new Error("One or more threads were not found or access was denied");
	}

	// A single job for the whole selection, deleteMail (worker) accepts an array.
	await smtpQueue.add(
		"mail:delete-permanent",
		{ threadId: ids, mailboxId, imapDelete },
		{
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

	await Promise.all(
		ids.map(async (threadId) => {
			await searchIngestQueue.add(
				"refresh-thread",
				{ threadId },
				{
					jobId: `refresh-${threadId}`,
					removeOnComplete: true,
					removeOnFail: false,
					attempts: 3,
					backoff: { type: "exponential", delay: 1500 },
				},
			);
		}),
	);

	if (refresh) {
		await waitForThreadsToLeave(ids, mailboxId);
		revalidatePath("/mail");
	}
}

export async function addNewMailboxFolder(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const decodedForm = decode(formData);
	// Visible identity (RLS); parent mailbox of this identity. The IMAP mode follows the
	// re-read identity (the form used to send its smtpAccountId).
	const user = await assertSignedIn();
	const identity = await assertIdentityAccess({ id: String(decodedForm.identityId ?? "") });
	const isImapOp = !!identity.smtpAccountId;
	const requestedParentId =
		decodedForm.parentId && decodedForm.parentId !== "none"
			? String(decodedForm.parentId)
			: null;
	let verifiedParentId: string | null = null;
	if (requestedParentId) {
		const parent = await assertMailboxAccess(requestedParentId).catch(() => null);
		if (!parent || parent.identityId !== identity.id) {
			return { success: false, error: "Invalid parent folder" } as any;
		}
		verifiedParentId = parent.id;
	}
	if (isImapOp) {
		const { smtpQueue, smtpEvents } = await getRedis();
		const job = await smtpQueue.add(
			"mailbox:add-new",
			{
				name: decodedForm.name,
				parentId: verifiedParentId,
				identityId: identity.id,
				ownerId: user.id,
				kind: "custom",
				slug: slugify(String(decodedForm.name)),
			},
			{
				attempts: 3,
				backoff: { type: "exponential", delay: 1500 },
				removeOnComplete: true,
				removeOnFail: true,
			},
		);

		await job.waitUntilFinished(smtpEvents);
		revalidatePath("/dashboard/mail");
	} else {
		const name = String(decodedForm.name ?? "").trim();
		if (!name)
			return { success: false, error: "Folder name is required" } as any;

		const ownerId = user.id;
		const identityId = identity.id;
		const parentId = verifiedParentId;
		const workspaceId = identity.workspaceId;
		await db
			.insert(mailboxes)
			.values({
				ownerId,
				workspaceId,
				identityId,
				parentId,
				kind: "custom",
				name,
				slug: slugify(name.toLowerCase()),
				isDefault: false,
				metaData: {},
			})
			.returning();

		revalidatePath("/dashboard/mail");
	}

	return {
		success: true,
	};
}

export async function deleteMailboxFolder({
											  imapOp,
											  identityId,
											  mailboxId,
										  }: {
	imapOp: boolean;
	identityId: string;
	mailboxId: string;
}): Promise<FormState> {
	// Signed-in user, visible mailbox (RLS), and identity of the URL that really is the
	// mailbox's; any mailboxId used to be deleted.
	const user = await assertSignedIn();
	const mailbox = await assertMailboxAccess(mailboxId).catch(() => null);
	if (!mailbox) return { success: false, error: "Folder not found" } as any;
	const ident = await assertIdentityAccess({ publicId: String(identityId ?? "") }).catch(() => null);
	if (!ident || ident.id !== mailbox.identityId) {
		return { success: false, error: "Folder not found" } as any;
	}

	if (!imapOp) {
		if (mailbox.isDefault)
			return { success: false, error: "Cannot delete a default folder" } as any;

		// Delete any subfolders first
		await db.delete(mailboxes).where(eq(mailboxes.parentId, mailbox.id));

		// Delete this mailbox and any sync info
		await db.delete(mailboxSync).where(eq(mailboxSync.mailboxId, mailbox.id));
		await db.delete(mailboxes).where(eq(mailboxes.id, mailbox.id));

		revalidatePath("/dashboard/mail");
		return { success: true };
	}

	const { smtpQueue, smtpEvents } = await getRedis();

	const job = await smtpQueue.add(
		"mailbox:delete-folder",
		{
			mailboxId: mailbox.id,
			identityId: ident.id,
			ownerId: user.id,
		},
		{
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

	await job.waitUntilFinished(smtpEvents);
	// Upstream forgot the /w/<id>/ segment, hence a 404 after every deletion.
	redirect(`/w/${await getWorkspacePublicId()}/dashboard/mail/${ident.publicId}/inbox`);
	return { success: true };
}

export const moveToFolder = async (
	threadIds: string | string[],
	fromMailboxId: string, // current mailbox
	toMailboxId: string, // destination mailbox (UUID)
	moveImap: boolean, // perform IMAP move when true
	refresh: boolean,
	messageId?: string,
) => {
	const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);

	if (
		!requestedIds.length ||
		!fromMailboxId ||
		!toMailboxId ||
		fromMailboxId === toMailboxId
	)
		return;

	// Source and destination mailboxes visible, of the same identity (the worker only
	// looked for the destination in the identity of the source), threads and message of
	// the source only.
	const { mailbox: from, threadIds: ids } = await assertThreadsInMailbox(fromMailboxId, requestedIds);
	const to = await assertMailboxAccess(toMailboxId);
	if (!ids.length || to.identityId !== from.identityId) return;
	// No mail moved into Drafts (the worker refuses it too).
	if ((to as any).kind === "drafts") return;
	if (messageId && !(await messageInMailbox(messageId, from.id))) return;
	fromMailboxId = from.id;
	toMailboxId = to.id;
	moveImap = shouldMoveImap(moveImap, await imapSynced(from.id));

	const { smtpQueue, searchIngestQueue } = await getRedis();

	// A single job for the whole selection (see moveMail, worker): one job per thread,
	// processed one by one with its own IMAP round trip, made the selection disappear one
	// thread at a time.
	await smtpQueue.add(
		"mail:move",
		{
			threadId: ids[0],
			threadIds: ids,
			mailboxId: fromMailboxId,
			op: "move",
			toMailboxId,
			messageId,
			moveImap,
		},
		{
			jobId: `move:${ids[0]}+${ids.length - 1}:${fromMailboxId}->${toMailboxId}`,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
			removeOnComplete: true,
			removeOnFail: false,
		},
	);

	await Promise.all(
		ids.map((threadId) =>
			searchIngestQueue.add(
				"refresh-thread",
				{ threadId },
				{
					jobId: `refresh-${threadId}`,
					removeOnComplete: true,
					removeOnFail: false,
					attempts: 3,
					backoff: { type: "exponential", delay: 1500 },
				},
			),
		),
	);

	if (refresh) {
		await waitForThreadsToLeave(ids, fromMailboxId);
		revalidatePath("/mail");
	}
};



// "Scheduled" counter of the sidebar: only the id and the identity are read (the content of the
// messages has no business in the HTML of the page), identity visible to the user.
export type ScheduledDraftCount = { id: string; identityId: string };

export const fetchScheduledDraftCounts = async (): Promise<ScheduledDraftCount[]> => {
	const rls = await rlsClient();

	return await rls((tx) =>
		tx
			.select({ id: draftMessages.id, identityId: identities.id })
			.from(draftMessages)
			.innerJoin(identities, eq(draftMessages.identityId, identities.id))
			.where(eq(draftMessages.status, "scheduled")),
	);
};


export const fetchScheduledDrafts = async (identityPublicId: string) => {
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx
			.select()
			.from(identities)
			.where(eq(identities.publicId, identityPublicId)),
	);
	const rows = await rls((tx) =>
		tx
			.select()
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "scheduled"),
					eq(draftMessages.identityId, identity.id),
				),
			),
	);
	return rows;
};

export async function deleteScheduledDraft(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData) as Record<string, unknown>;
		const rowId = String(decodedForm.draftId);
		const rls = await rlsClient();
		// Job removed and row set to "canceled" (RLS: the row must be visible), then the source
		// draft becomes an editable draft again (send mark cleared).
		const row = await cancelScheduledRow(rowId);
		if (!row) {
			return { success: false, error: "This message has already left or is being sent." };
		}
		// The row may be the only copy of the message (source draft deleted or never saved): it is
		// only deleted once an IMAP draft is found or recreated.
		try {
			await restoreDraftFromRow(row, { onlyIfMissing: true });
		} catch (e) {
			console.error("[send] draft restore before delete failed", e);
			return {
				success: false,
				error: "Send canceled, but the draft could not be recreated: the message is kept.",
			};
		}
		await rls(async (tx) => {
			await tx.delete(draftMessages).where(eq(draftMessages.id, rowId));
		});

		revalidatePath("/dashboard/mail");
		return { success: true };
	});
}

// Outbox: sends waiting, in progress, and failures not dismissed, read from the
// draft_messages ledger (states: packages/common/src/outbox-state.ts). Candidates in SQL,
// exact visibility through isOutboxVisible.
const outboxCandidate = or(
	inArray(draftMessages.status, ["scheduled", "sending"]),
	and(eq(draftMessages.status, "failed"), isNull(draftMessages.dismissedAt)),
	and(eq(draftMessages.status, "sent"), notInArray(draftMessages.deliveryState, ["none", "delivered"])),
);

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

const outboxStateCols = {
	id: draftMessages.id,
	identityId: draftMessages.identityId,
	status: draftMessages.status,
	deliveryState: draftMessages.deliveryState,
	acceptanceUnknown: draftMessages.acceptanceUnknown,
	acceptedAt: draftMessages.acceptedAt,
	dismissedAt: draftMessages.dismissedAt,
};

// Sidebar counter, per identity visible to the user: total of visible sends and number of
// alerts (failed, interrupted), plus what is needed to refresh the page while a send moves
// (lib/outbox-view.ts, outboxRefreshOf). Neither content nor recipients.
export type OutboxCount = { identityId: string; total: number; alert: number } & OutboxTracking;

export const fetchOutboxCounts = async (): Promise<OutboxCount[]> => {
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({ ...outboxStateCols, scheduledAt: draftMessages.scheduledAt })
			.from(draftMessages)
			.innerJoin(identities, eq(draftMessages.identityId, identities.id))
			.where(outboxCandidate),
	);
	const byIdentity = new Map<string, typeof rows>();
	for (const r of rows) {
		if (!r.identityId) continue;
		byIdentity.set(r.identityId, [...(byIdentity.get(r.identityId) ?? []), r]);
	}
	return [...byIdentity].map(([identityId, list]) => {
		const states = list.map((r) => ({ r, state: sendStateOf(r) }));
		return {
			identityId,
			...outboxCountOf(list),
			busy: states.filter(({ state }) => state === "sending" || state === "queued" || state === "canceling").length,
			pendingAt: states.filter(({ state }) => state === "pending").map(({ r }) => iso(r.scheduledAt)!).filter(Boolean),
		};
	});
};

// Visible Outbox rows of an identity: Drafts hides the matching drafts (lib/outbox-view.ts,
// inOutbox).
export const fetchOutboxIds = async (identityPublicId: string): Promise<string[]> =>
	(await fetchOutbox(identityPublicId)).map((i) => i.id);

export type OutboxItem = {
	id: string;
	state: SendState;
	actions: OutboxActions;
	origin: string;
	subject: string;
	to: string[];
	scheduledAt: string | null;
	updatedAt: string;
	error: string | null;
	draftMessageId: string | null;
};

// Outbox list of an identity: failures first (to handle), then in progress, then waiting by
// send time. The message content stays on the server.
export const fetchOutbox = async (identityPublicId: string): Promise<OutboxItem[]> => {
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx.select({ id: identities.id }).from(identities).where(eq(identities.publicId, identityPublicId)),
	);
	if (!identity) return [];
	const rows = await rls((tx) =>
		tx
			.select({
				...outboxStateCols,
				origin: draftMessages.origin,
				scheduledAt: draftMessages.scheduledAt,
				updatedAt: draftMessages.updatedAt,
				lastError: draftMessages.lastError,
				subject: sql<string | null>`${draftMessages.payload}->>'subject'`,
				to: sql<unknown>`${draftMessages.payload}->'to'`,
				draftMessageId: sql<string | null>`${draftMessages.payload}->>'draftMessageId'`,
				legacyError: sql<string | null>`${draftMessages.payload}->>'__error'`,
			})
			.from(draftMessages)
			.where(and(eq(draftMessages.identityId, identity.id), outboxCandidate)),
	);
	const rank: Partial<Record<SendState, number>> = { failed: 0, interrupted: 0, rejected: 0, unknown: 1, canceling: 1, sending: 2, queued: 2, pending: 3 };
	return rows
		.filter((r) => isOutboxVisible(r))
		.map((r) => ({
			id: r.id,
			state: sendStateOf(r)!,
			actions: outboxActionsOf(r),
			origin: r.origin,
			subject: String(r.subject ?? ""),
			to: toArray(r.to as any),
			scheduledAt: iso(r.scheduledAt),
			updatedAt: iso(r.updatedAt)!,
			error: r.lastError ?? r.legacyError ?? null,
			draftMessageId: r.draftMessageId ?? null,
		}))
		.sort(
			(a, b) =>
				(rank[a.state] ?? 9) - (rank[b.state] ?? 9) ||
				String(a.scheduledAt ?? a.updatedAt).localeCompare(String(b.scheduledAt ?? b.updatedAt)),
		);
};

// "Retry" a failed send: CAS failed -> scheduled, never after the server accepted it; an
// interrupted send (may have been sent) asks for confirmation. Refused if the draft changed
// since the failure (the old content would be sent). The old job with the same id is removed
// (BullMQ would ignore the add), then the job leaves without delay; on failure, the row goes
// back to failed.
export async function retryOutboxSend(
	rowId: string,
	opts: { confirmed?: boolean } = {},
): Promise<{ ok: boolean; needsConfirm?: boolean; error?: string }> {
	const seen = await scheduledRowOf(String(rowId));
	if (!seen) return { ok: false, error: "Send not found." };
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ ...outboxStateCols, updatedAt: draftMessages.updatedAt, lastError: draftMessages.lastError })
			.from(draftMessages)
			.where(eq(draftMessages.id, seen.id))
			.limit(1),
	);
	if (!row || !outboxActionsOf(row).retry) return { ok: false, error: "This send cannot be retried." };
	if (outboxActionsOf(row).confirmRetry && !opts.confirmed) return { ok: false, needsConfirm: true };
	const draftId = await ownedDraftId(String(seen.payload?.draftMessageId ?? ""));
	if (draftId) {
		const [draft] = await rls((tx) =>
			tx
				.select({ metaData: messages.metaData, createdAt: messages.createdAt, updatedAt: messages.updatedAt })
				.from(messages)
				.where(eq(messages.id, draftId))
				.limit(1),
		);
		const savedAt = draft ? draftTimesOf(draft as any).savedAt : null;
		if (savedAt && new Date(savedAt).getTime() > new Date(row.updatedAt).getTime()) {
			return { ok: false, error: "The draft changed since the failure: open it and send it again." };
		}
	}
	const now = new Date();
	const [won] = await rls((tx) =>
		tx
			.update(draftMessages)
			.set({ status: "scheduled", scheduledAt: now, acceptanceUnknown: false, lastError: null, updatedAt: now })
			.where(
				and(
					eq(draftMessages.id, seen.id),
					eq(draftMessages.status, "failed"),
					isNull(draftMessages.acceptedAt),
					isNull(draftMessages.dismissedAt),
					opts.confirmed ? sql`true` : eq(draftMessages.acceptanceUnknown, false),
				),
			)
			.returning({ id: draftMessages.id }),
	);
	if (!won) return { ok: false, error: "This send changed state in the meantime." };
	const revert = async () => {
		await rls((tx) =>
			tx
				.update(draftMessages)
				.set({ status: "failed", acceptanceUnknown: row.acceptanceUnknown, lastError: row.lastError, updatedAt: new Date() })
				.where(and(eq(draftMessages.id, seen.id), eq(draftMessages.status, "scheduled"))),
		);
		if (draftId) await setDraftSendState(draftId, { pendingSend: null });
	};
	try {
		if (draftId) {
			await setDraftSendState(draftId, {
				pendingSend: { jobId: seen.id, sendAt: now.toISOString() },
				sendError: null,
			});
		}
		const { sendMailQueue } = await getRedis();
		// A job still active (worker stuck) refuses the removal: no retry.
		await (await sendMailQueue.getJob(seen.id))?.remove();
		const job = scheduledJobOf({ id: seen.id, identityId: seen.identityId, scheduledAt: now, payload: seen.payload });
		await sendMailQueue.add(job.name, job.data, { ...job.opts, delay: 0 });
	} catch (e) {
		console.error("[outbox] retry failed", e);
		await revert().catch((err) => console.error("[outbox] retry revert failed", err));
		return { ok: false, error: "Cannot retry right now." };
	}
	revalidatePath("/dashboard/mail");
	return { ok: true };
}

// "Back to drafts": the failure is dismissed from the Outbox (CAS on dismissed_at), then the
// draft is found as is, or recreated from the row if it is gone. A direct send (without a
// source draft) is only dismissed (dismissRestoresDraft).
export async function dismissOutboxSend(rowId: string): Promise<{ ok: boolean; error?: string }> {
	const seen = await scheduledRowOf(String(rowId));
	if (!seen) return { ok: false, error: "Send not found." };
	const rls = await rlsClient();
	const [won] = await rls((tx) =>
		tx
			.update(draftMessages)
			.set({ dismissedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(draftMessages.id, seen.id),
					isNull(draftMessages.dismissedAt),
					or(
						eq(draftMessages.status, "failed"),
						and(eq(draftMessages.status, "sent"), eq(draftMessages.deliveryState, "rejected")),
					),
				),
			)
			.returning({ id: draftMessages.id }),
	);
	if (!won) return { ok: false, error: "This send changed state in the meantime." };
	if (!dismissRestoresDraft(seen.origin)) {
		await unlockDraftOfRow(seen).catch((e) => console.error("[outbox] unlock on dismiss failed", e));
		revalidatePath("/dashboard/mail");
		return { ok: true };
	}
	try {
		await restoreDraftFromRow(seen, { onlyIfMissing: true });
	} catch (e) {
		console.error("[outbox] draft restore on dismiss failed", e);
		return { ok: false, error: "Send dismissed, but the draft could not be recreated." };
	}
	revalidatePath("/dashboard/mail");
	return { ok: true };
}

export async function snoozeThread(input: {
	mailboxThreadId: string;
	activeMailboxId: string;
	snoozedUntil: string | null;
}) {
	return handleAction(async () => {
		const { mailboxThreadId, activeMailboxId, snoozedUntil } = input;

		const rls = await rlsClient();
		await rls(async (tx) => {
			return tx
				.update(mailboxThreads)
				.set({
					snoozedUntil: snoozedUntil ? new Date(snoozedUntil) : null,
					unsnoozedAt: snoozedUntil ? null : new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(mailboxThreads.threadId, mailboxThreadId),
						eq(mailboxThreads.mailboxId, activeMailboxId),
					),
				)
				.returning();
		});

		revalidatePath("/dashboard/mail");
		return { success: true };
	});
}

// Archive for a chosen duration, for threads already archived, in a single call. A null
// expiresAt cancels the expiry. A starred thread or one with a row in the Inbox of the same
// identity is set aside (counted in skipped): the mbth_expiry_guard trigger and
// upsertMailboxThreadItem would clear the expiry at once, the displayed date would be a lie. No
// row touched (thread moved to Trash or elsewhere in the meantime) is never a success: ok false,
// with the reason.
export async function setThreadExpiry(input: {
	threadIds: string[];
	mailboxId: string;
	expiresAt: string | null;
}): Promise<{ ok: true; updated: number; skipped: number; expiresAt: string | null } | { ok: false; reason: string }> {
	try {
		const { mailbox, threadIds } = await assertThreadsInMailbox(input.mailboxId, input.threadIds);
		if (!threadIds.length) return { ok: false, reason: "Thread not found in this folder" };
		if (mailbox.kind !== "archive") {
			return { ok: false, reason: "The expiry can only be set in the archive" };
		}
		const expiry = input.expiresAt === null ? null : parseExpiry(input.expiresAt, new Date());
		if (input.expiresAt !== null && !expiry) {
			return { ok: false, reason: "Invalid date: pick a day in the future, within ten years" };
		}

		const rls = await rlsClient();
		let eligible = threadIds;
		if (expiry) {
			const rows = await rls((tx) =>
				tx
					.select({ threadId: mailboxThreads.threadId, starred: mailboxThreads.starred })
					.from(mailboxThreads)
					.where(and(inArray(mailboxThreads.threadId, threadIds), eq(mailboxThreads.mailboxId, mailbox.id))),
			);
			const inboxRows = await rls((tx) =>
				tx
					.select({ threadId: mailboxThreads.threadId })
					.from(mailboxThreads)
					.innerJoin(mailboxes, eq(mailboxes.id, mailboxThreads.mailboxId))
					.where(
						and(
							inArray(mailboxThreads.threadId, threadIds),
							eq(mailboxThreads.identityId, mailbox.identityId),
							eq(mailboxes.kind, "inbox"),
						),
					),
			);
			const starred = new Set(rows.filter((r) => r.starred).map((r) => r.threadId));
			const inInbox = new Set(inboxRows.map((r) => r.threadId));
			eligible = rows.map((r) => r.threadId).filter((id) => !starred.has(id) && !inInbox.has(id));
			if (!eligible.length) {
				if (!rows.length) return { ok: false, reason: "Thread not found in this folder" };
				return {
					ok: false,
					reason: starred.size
						? "A starred thread does not expire: remove the star first"
						: "This thread is also in the Inbox: it will not expire",
				};
			}
		}

		const touched = await rls((tx) =>
			tx
				.update(mailboxThreads)
				.set({ expiresAt: expiry, updatedAt: new Date() })
				.where(and(inArray(mailboxThreads.threadId, eligible), eq(mailboxThreads.mailboxId, mailbox.id)))
				.returning({ threadId: mailboxThreads.threadId }),
		);
		if (touched.length === 0) {
			return { ok: false, reason: "Nothing was updated: the thread is no longer in the archive (moved or deleted in the meantime)" };
		}
		revalidatePath("/dashboard/mail");
		return {
			ok: true,
			updated: touched.length,
			skipped: threadIds.length - touched.length,
			expiresAt: expiry ? expiry.toISOString() : null,
		};
	} catch (e: any) {
		return { ok: false, reason: e?.message ?? "Update failed" };
	}
}

// Threads of the identity that have an expiry, in its archive folder, closest first ("Expiring
// soon" view). Filtered on the server: the 200 rows are those of the identity.
export const fetchIdentityExpiringThreads = async (
	identityPublicId: string,
): Promise<{ threads: MailboxThreadEntity[] }> => {
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({ thread: mailboxThreads })
			.from(mailboxThreads)
			.innerJoin(mailboxes, eq(mailboxes.id, mailboxThreads.mailboxId))
			.where(
				and(
					isNotNull(mailboxThreads.expiresAt),
					eq(mailboxThreads.identityPublicId, identityPublicId),
					eq(mailboxes.kind, "archive"),
				),
			)
			.orderBy(asc(mailboxThreads.expiresAt), desc(mailboxThreads.lastActivityAt))
			.limit(200),
	);
	return { threads: rows.map((r) => r.thread) };
};

// Number of threads that will expire, per identity (id), for the sidebar. Computed on the server:
// no row limit, no filter to redo in the browser.
export const fetchExpiringCounts = async (): Promise<Record<string, number>> => {
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({ identityId: mailboxThreads.identityId, n: count() })
			.from(mailboxThreads)
			.innerJoin(mailboxes, eq(mailboxes.id, mailboxThreads.mailboxId))
			.where(and(isNotNull(mailboxThreads.expiresAt), eq(mailboxes.kind, "archive")))
			.groupBy(mailboxThreads.identityId),
	);
	return Object.fromEntries(rows.map((r) => [String(r.identityId), Number(r.n)]));
};

// Expiry and star of the open thread, in the folder where it is (the "Disappears on" notice and
// the archive toast message).
export const fetchThreadExpiry = async (
	threadId: string,
	mailboxId: string,
): Promise<{ expiresAt: string | null; starred: boolean }> => {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ expiresAt: mailboxThreads.expiresAt, starred: mailboxThreads.starred })
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)))
			.limit(1),
	);
	return { expiresAt: row?.expiresAt ? new Date(row.expiresAt).toISOString() : null, starred: !!row?.starred };
};

export const fetchIdentitySnoozedThreads = async (): Promise<{ threads: MailboxThreadEntity[] }> => {
	const rls = await rlsClient();
	const now = new Date();

	const rows = await rls((tx) =>

		tx
			.select({
				thread: mailboxThreads
			})
			.from(mailboxThreads)
			.where(
				and(
					isNotNull(mailboxThreads.snoozedUntil),
					gt(mailboxThreads.snoozedUntil, now),
				),
			)
			.orderBy(
				desc(mailboxThreads.snoozedUntil),
				desc(mailboxThreads.lastActivityAt),
			)
	)

	return {
		threads: rows.map((r) => r.thread),
	};
};


// Same key as the worker ingestion (@common list-unsubscribe), List-Id included: the key
// used to ignore list.id and a shared router (bulk mail service) merged all its customers.
function subscriptionKeyFromMessage(m: { headersJson: any; from?: any }) {
	const fromEmail = String(m.from?.value?.[0]?.address ?? "").trim().toLowerCase() || null;
	return subscriptionKeyOf(extractListUnsubscribe(m.headersJson), fromEmail);
}

export async function fetchThreadMailSubscriptions(opts: {
	ownerId: string;
	messages: Array<{ id: string; headersJson: any; from?: any }>;
}) {
	// Subscriptions of the signed-in user only; the ownerId passed by the caller (client
	// included: it is an action) is no longer used.
	const user = await isSignedIn();
	const keysByMessageId = new Map<string, string>();
	if (!user?.id) return { byMessageId: new Map<string, any>(), keysByMessageId };

	for (const m of opts.messages) {
		const key = subscriptionKeyFromMessage(m);
		if (key) keysByMessageId.set(m.id, key);
	}

	const uniqueKeys = Array.from(new Set(keysByMessageId.values()));
	if (!uniqueKeys.length) {
		return { byMessageId: new Map<string, any>(), keysByMessageId };
	}

	const rows = await db
		.select()
		.from(mailSubscriptions)
		.where(
			and(
				eq(mailSubscriptions.ownerId, user.id),
				inArray(mailSubscriptions.subscriptionKey, uniqueKeys),
			),
		);

	const byKey = new Map(rows.map((r) => [r.subscriptionKey, r]));
	const byMessageId = new Map<string, any>();

	for (const [messageId, key] of keysByMessageId.entries()) {
		byMessageId.set(messageId, byKey.get(key) ?? null);
	}

	return { byMessageId, keysByMessageId };
}

export type FetchThreadMailSubsResult = Awaited<
	ReturnType<typeof fetchThreadMailSubscriptions>
>;
