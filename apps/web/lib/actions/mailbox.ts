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
	ne,
} from "drizzle-orm";
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
import { extractListUnsubscribe, subscriptionKeyOf, draftSendStateOf, draftTimesOf, setDraftSendState, shouldMoveImap, type DraftSendState, type DraftTimes } from "@common";
import { getRedis } from "@/lib/actions/get-redis";
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
			rls((tx) =>
				tx
					.select({ count: count() })
					.from(messages)
					.where(eq(messages.mailboxId, activeMailbox.id))
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
				// The trash does not display an unread counter.
				.innerJoin(
					mailboxes,
					and(
						eq(mailboxes.id, mailboxThreads.mailboxId),
						ne(mailboxes.kind, "trash"),
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

// Content-Disposition attachment with an ASCII fallback name and a UTF-8 name (RFC 6266).
function attachmentDisposition(filename: string | null | undefined) {
	const name = (filename || "piece-jointe").replace(/[\r\n"\\]/g, "_");
	const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");
	const utf8 = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

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
		attachments.map(async (attachment) => {
			const command = new GetObjectCommand({
				Bucket: S3_BUCKET!,
				Key: attachment.path!,
			});

			const url = await getSignedUrl(s3, command, { expiresIn: 300 });
			// Second URL for the download arrow. The S3 URL is on another origin, the
			// download attribute of <a> is ignored there: only a Content-Disposition
			// attachment forces saving to Downloads instead of opening.
			const downloadUrl = await getSignedUrl(
				s3,
				new GetObjectCommand({
					Bucket: S3_BUCKET!,
					Key: attachment.path!,
					ResponseContentDisposition: attachmentDisposition(attachment.filenameOriginal),
				}),
				{ expiresIn: 300 },
			);

			return {
				...attachment,
				signedUrl: url,
				downloadUrl,
			};
		}),
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
		if (draftId) decodedForm.draftMessageId = draftId;
		else delete decodedForm.draftMessageId;
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
	if (scheduledAtRaw) {
		const d = dayjs(scheduledAtRaw);
		if (!d.isValid()) {
			return { success: false, error: "Invalid scheduled time." };
		}

		const identityId = await rls(async (tx) => {
			const [identity] = await tx
				.select({
					identityId: mailboxes.identityId,
				})
				.from(mailboxes)
				.where(eq(mailboxes.id, decodedForm.mailboxId));
			return identity?.identityId;
		});

		const parsed = DraftMessageInsertSchema.safeParse({
			identityId,
			mailboxId: decodedForm.mailboxId,
			payload: decodedForm,
			status: "scheduled",
			scheduledAt: d.toDate(),
		});

		if (!parsed.success) {
			return {
				success: false,
				error: "There was an error trying to schedule your mail.",
			};
		}

		const row = await rls(async (tx) => {
			const [created] = await tx
				.insert(draftMessages)
				.values(parsed.data)
				.returning({
					id: draftMessages.id,
					scheduledAt: draftMessages.scheduledAt,
				});
			return created ?? null;
		});

		if (!row?.id || !row.scheduledAt) {
			return { success: false, error: "Failed to schedule your mail." };
		}

		const { sendMailQueue } = await getRedis();
		const delay = Math.max(
			0,
			Number(new Date(row.scheduledAt)) - Number(new Date()),
		);

		await sendMailQueue.add(
			"send-scheduled-draft",
			{ draftMessageId: row.id },
			{ jobId: row.id, delay },
		);
		revalidatePath("/dashboard/mail");
		return { success: true, data: { draftMessageId: row.id } };
	}

	// Undo send. The job goes out with a delay: the interface offers "Undo" (job removal)
	// and "Send now" (job promotion) during that delay. Server-side, so closing the tab
	// does not prevent the send.
	// Delay chosen by the user (Settings > Compose), 0 = send immediately.
	const undoMs = (await undoSendSeconds()) * 1000;
	const { sendMailQueue } = await getRedis();
	const job = await sendMailQueue.add("send-and-reconcile", decodedForm, {
		jobId: `undo-send-${crypto.randomUUID()}`,
		delay: undoMs,
	});
	// The original draft carries the "sending" mark (Drafts list, opening).
	await markDraftPending(
		String(decodedForm.draftMessageId ?? ""),
		String(job.id),
		undoMs,
	);
	return {
		success: true,
		message: "Message sent",
		data: { pendingSendId: String(job.id), undoMs },
	};
}

// The draft is only touched if it is visible to the user (RLS).
async function ownedDraftId(draftMessageId: string) {
	if (!draftMessageId) return null;
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ id: messages.id })
			.from(messages)
			.where(and(eq(messages.id, draftMessageId), eq(messages.draft, true)))
			.limit(1),
	);
	return row?.id ?? null;
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

// "Undo" of a send still pending. Returns the form if the job was removed; if it has
// already gone (or is being sent), nothing more can be done.
export async function cancelPendingSend(pendingSendId: string) {
	const job = await ownedPendingSend(pendingSendId);
	if (!job) return { cancelled: false as const };
	try {
		if ((await job.getState()) !== "delayed") return { cancelled: false as const };
		await job.remove();
		try {
			const id = await ownedDraftId(String((job.data as any)?.draftMessageId ?? ""));
			if (id) await setDraftSendState(id, { pendingSend: null });
		} catch (e) {
			console.error("[send] pendingSend clear failed", e);
		}
		return { cancelled: true as const };
	} catch {
		return { cancelled: false as const };
	}
}

// "Send now": the pending job goes out immediately.
export async function sendPendingNow(pendingSendId: string) {
	const job = await ownedPendingSend(pendingSendId);
	if (!job) return;
	try {
		if ((await job.getState()) === "delayed") await job.promote();
		const id = await ownedDraftId(String((job.data as any)?.draftMessageId ?? ""));
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
	if (!job) return {};
	const { sendMailEvents } = await getRedis();
	try {
		return (await job.waitUntilFinished(sendMailEvents, 120_000)) ?? {};
	} catch (e: any) {
		return { error: e?.message ?? "Sending failed" };
	}
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
export const archiveThread = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
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
		{ threadId: ids[0], threadIds: ids, mailboxId: src.id, op: "archive", moveImap },
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



export const fetchScheduledDraftCounts = async () => {
	const rls = await rlsClient();

	const rows = await rls((tx) =>
		tx
			.select()
			.from(draftMessages)
			.where(
				eq(draftMessages.status, "scheduled")
			)
	);

	return rows;
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
		const rls = await rlsClient();
		await rls(async (tx) => {
			await tx
				.delete(draftMessages)
				.where(eq(draftMessages.id, String(decodedForm.draftId)));
		});

		revalidatePath("/dashboard/mail");
		return { success: true };
	});
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
