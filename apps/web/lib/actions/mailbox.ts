"use server";

import { cache } from "react";
import {getWorkspaceId, getWorkspacePublicId, rlsClient} from "@/lib/actions/clients";
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
import { getRedis } from "@/lib/actions/get-redis";
import dayjs from "dayjs";
import {fetchWorkspace} from "@/lib/actions/workspace";

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

		if (!identity) throw new Error("Identity not found");

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

		if (!activeMailbox) throw new Error("Mailbox not found");

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
					sql`${mailboxes.kind} NOT IN ('outbox','drafts')`,
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
				.where(
					// ss2i : seuls les fils non lus comptent ; sans ce filtre, la politique RLS
					// (sous-requete EXISTS par ligne) s'evaluait sur toute la table : 680 ms a
					// chaque affichage pour 22 000 fils, contre quelques ms ici.
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

			return {
				...attachment,
				signedUrl: url,
			};
		}),
	);
	return results;
}

export const revalidateMailbox = async (path: string) => {
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
	// L'utilisateur qui envoie : c'est son carnet d'adresses que le worker alimente.
	const sender = await isSignedIn();
	decodedForm.senderUserId = sender?.id ?? null;

	if (toArray(decodedForm.to as any).length === 0) {
		return {
			success: false,
			error: "Please provide at least one recipient in the To field.",
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

	// ss2i : annulation d'envoi. Le job part avec un delai : l'interface propose « Undo »
	// (retrait du job) et « Send now » (promotion du job) pendant ce delai. Cote serveur,
	// donc fermer l'onglet n'empeche pas l'envoi.
	const { sendMailQueue } = await getRedis();
	const job = await sendMailQueue.add("send-and-reconcile", decodedForm, {
		jobId: `undo-send-${crypto.randomUUID()}`,
		delay: UNDO_SEND_MS,
	});
	return {
		success: true,
		message: "Message sent",
		data: { pendingSendId: String(job.id), undoMs: UNDO_SEND_MS },
	};
}

const UNDO_SEND_MS = 30_000;

// ss2i : « Undo » d'un envoi encore en attente. Rend le formulaire si le job a bien ete
// retire ; s'il est deja parti (ou en cours d'envoi), on ne peut plus rien faire.
export async function cancelPendingSend(pendingSendId: string) {
	const { sendMailQueue } = await getRedis();
	const job = await sendMailQueue.getJob(pendingSendId);
	if (!job) return { cancelled: false as const };
	try {
		if ((await job.getState()) !== "delayed") return { cancelled: false as const };
		await job.remove();
		return { cancelled: true as const };
	} catch {
		return { cancelled: false as const };
	}
}

// ss2i : « Send now » : le job en attente part tout de suite.
export async function sendPendingNow(pendingSendId: string) {
	const { sendMailQueue } = await getRedis();
	const job = await sendMailQueue.getJob(pendingSendId);
	if (!job) return;
	try {
		if ((await job.getState()) === "delayed") await job.promote();
	} catch {
		// deja parti
	}
}

// ss2i : resultat de l'envoi, appele une fois le delai ecoule (ou apres « Send now »)
// pour afficher une erreur eventuelle. Jamais pendant le delai : les actions serveur
// d'un onglet passent une par une, attendre ici bloquerait toutes les autres.
export async function waitPendingSend(pendingSendId: string): Promise<FormState> {
	const { sendMailQueue, sendMailEvents } = await getRedis();
	const job = await sendMailQueue.getJob(pendingSendId);
	if (!job) return {};
	try {
		return (await job.waitUntilFinished(sendMailEvents, 120_000)) ?? {};
	} catch (e: any) {
		return { error: e?.message ?? "Sending failed" };
	}
}

export const deltaFetch = async ({ identityId }: { identityId: string }) => {
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

	const client = getTypeSenseClient();

	const filters = [
		`workspacePublicId:=${JSON.stringify(workspacePublicId)}`,
		`identityPublicId:=${JSON.stringify(identityPublicId)}`,
		`mailboxSlug:=${JSON.stringify(mailboxSlug)}`,
	];

	if (hasAttachment) filters.push("hasAttachment:=1");
	if (onlyUnread) filters.push("unread:=1");
	if (starred) filters.push("starred:=1");

	const result = (await client.collections("messages").documents().search({
		q,
		query_by: "subject,snippet,fromName,fromEmail,participants",
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




export const backfillMailboxes = async (identityId: string, workspaceId: string) => {
	const { smtpQueue, smtpEvents } = await getRedis();
	const job = await smtpQueue.add(
		"imap:backfill-discover",
		{ identityId, workspaceId },
		{
			jobId: `imap-backfill-discover-${identityId}`,
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 1000,
			},
		},
	);
	await job.waitUntilFinished(smtpEvents);
	backfillAccount(identityId, workspaceId);
};

export const backfillAccount = async (identityId: string, workspaceId: string) => {
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(
		"imap:backfill-account",
		{identityId},
		{
			removeOnComplete: true,
			removeOnFail: false,
			jobId: `imap-backfill-account-${identityId}`,
		},
	);
	await smtpQueue.add(
		"imap:start-idle",
		{ identityId },
		{
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);
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
		const ids = (Array.isArray(threadIds) ? threadIds : [threadIds])
			.map(String)
			.filter(Boolean);

		if (!ids.length || !mailboxId) return;

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
	const ids = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);

	if (!ids.length || !mailboxId) return;

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

// ss2i : deplacements et suppressions sont faits par le worker. Revalider aussitot le job
// poste redessinait la liste AVANT la mise a jour en base : le toast disait « moved to
// Trash » et le fil restait affiche. On attend donc que les fils aient quitte le dossier
// (quelques dizaines de ms en temps normal), avec un plafond pour ne jamais bloquer l'action.
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

export const moveToTrash = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
	messageId?: string,
) => {
	const ids = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);

	if (!ids.length || !mailboxId) return;

	// ss2i : depuis la corbeille, « supprimer » ne peut pas etre un deplacement vers la
	// corbeille (le job ne faisait rien et l'interface annoncait « moved to Trash ») :
	// c'est une suppression definitive, comme le bouton de l'en-tete de liste.
	const [source] = await db
		.select({ kind: mailboxes.kind })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (source?.kind === "trash") {
		await deleteForever(ids, mailboxId, moveImap, refresh);
		return "deleted" as const;
	}

	const { smtpQueue, searchIngestQueue } = await getRedis();

	// ss2i : un seul job pour toute la selection (cf. moveMail, worker) : un job par fil,
	// traites un a un avec chacun son aller-retour IMAP, faisait disparaitre la selection
	// au compte-gouttes.
	await smtpQueue.add(
		"mail:move",
		{ threadId: ids[0], threadIds: ids, mailboxId, op: "trash", messageId, moveImap },
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
	return "trashed" as const;
};

// Archiver = deplacer vers le dossier de kind « archive » de l'identite. Le worker
// (mail:move, op=archive) le cherche par kind ; s'il n'existe pas encore pour
// cette identite (Stalwart n'en cree pas), on le cree d'abord, cote IMAP quand
// la boite est synchronisee.
export const archiveThread = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
) => {
	const ids = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);
	if (!ids.length || !mailboxId) return;

	const [src] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (!src) return;
	if (src.kind === "archive") return;

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

	// ss2i : un seul job pour toute la selection (cf. moveMail, worker) : un job par fil,
	// traites un a un avec chacun son aller-retour IMAP, faisait disparaitre la selection
	// au compte-gouttes.
	await smtpQueue.add(
		"mail:move",
		{ threadId: ids[0], threadIds: ids, mailboxId, op: "archive", moveImap },
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
	threadId: string,
	mailboxId: string,
	starred: boolean,
	starImap: boolean,
) => {
	if (!threadId || !mailboxId) return;
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

	return rows.map((r) => r.thread);
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
	const { smtpQueue, searchIngestQueue } = await getRedis();

	if (emptyAll) {
		await smtpQueue.add(
			"mail:delete-permanent",
			{ mailboxId, emptyAll: true, imapDelete },
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

	const ids = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.filter(Boolean)
		.map(String);

	if (!ids.length || !mailboxId) return;

	// ss2i : un seul job pour toute la selection, deleteMail (worker) accepte un tableau.
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
	const isImapOp = String(decodedForm.imapOp).trim().length > 0;
	const user = await isSignedIn();
	if (isImapOp) {
		const { smtpQueue, smtpEvents } = await getRedis();
		const job = await smtpQueue.add(
			"mailbox:add-new",
			{
				name: decodedForm.name,
				parentId: decodedForm.parentId,
				identityId: decodedForm.identityId,
				ownerId: user?.id,
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

		const ownerId = String(user?.id ?? "");
		const identityId = String(decodedForm.identityId);
		const parentId =
			decodedForm.parentId && decodedForm.parentId !== "none"
				? String(decodedForm.parentId)
				: null;

		if (parentId) {
			const [parent] = await db
				.select({ id: mailboxes.id, identityId: mailboxes.identityId })
				.from(mailboxes)
				.where(eq(mailboxes.id, parentId))
				.limit(1);

			if (!parent || parent.identityId !== identityId) {
				return { success: false, error: "Invalid parent folder" } as any;
			}
		}

		const workspaceId = await getWorkspaceId();
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
	const user = await isSignedIn();

	if (!imapOp) {
		const [mailbox] = await db
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.id, mailboxId))
			.limit(1);

		if (!mailbox) return { success: false, error: "Folder not found" } as any;
		if (mailbox.isDefault)
			return { success: false, error: "Cannot delete a default folder" } as any;

		// Delete any subfolders first
		await db.delete(mailboxes).where(eq(mailboxes.parentId, mailboxId));

		// Delete this mailbox and any sync info
		await db.delete(mailboxSync).where(eq(mailboxSync.mailboxId, mailboxId));
		await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));

		revalidatePath("/dashboard/mail");
		return { success: true };
	}

	const [ident] = await db
		.select({ id: identities.id })
		.from(identities)
		.where(eq(identities.publicId, identityId))
		.limit(1);

	if (!ident) throw new Error("Identity not found");

	const { smtpQueue, smtpEvents } = await getRedis();

	const job = await smtpQueue.add(
		"mailbox:delete-folder",
		{
			mailboxId,
			identityId: ident.id,
			ownerId: user?.id,
		},
		{
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

	await job.waitUntilFinished(smtpEvents);
	// ss2i : l'amont oubliait le segment /w/<id>/, d'ou une 404 apres chaque suppression.
	redirect(`/w/${await getWorkspacePublicId()}/dashboard/mail/${identityId}/inbox`);
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
	const ids = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);

	if (
		!ids.length ||
		!fromMailboxId ||
		!toMailboxId ||
		fromMailboxId === toMailboxId
	)
		return;

	const { smtpQueue, searchIngestQueue } = await getRedis();

	// ss2i : un seul job pour toute la selection (cf. moveMail, worker) : un job par fil,
	// traites un a un avec chacun son aller-retour IMAP, faisait disparaitre la selection
	// au compte-gouttes.
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

export const clearImapClients = async (identityId: string) => {
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(
		"imap:stop-idle",
		{ identityId },
		{
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);
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


function subscriptionKeyFromHeadersJson(headersJson: any) {
	const list = headersJson?.list ?? null;
	const rawListId = String(headersJson?.["list-id"] ?? "").trim() || null;

	let unsubscribeHttpUrl: string | null = null;

	const fromList = list?.unsubscribe?.url || list?.unsubscribe?.href;
	if (typeof fromList === "string" && fromList) unsubscribeHttpUrl = fromList;

	const fromHeader = headersJson?.["list-unsubscribe"];
	if (!unsubscribeHttpUrl && typeof fromHeader === "string") {
		const parts = fromHeader
			.split(",")
			.map((s: string) => s.trim().replace(/^<|>$/g, ""));
		const http = parts.find((p: string) => /^https?:/i.test(p));
		if (http) unsubscribeHttpUrl = http;
	}

	if (rawListId) {
		const cleaned = rawListId
			.replace(/^<|>$/g, "")
			.replace(/\s+/g, "")
			.toLowerCase();
		return cleaned ? `list-id:${cleaned}` : null;
	}

	if (unsubscribeHttpUrl) {
		try {
			const u = new URL(unsubscribeHttpUrl);
			const p = (u.pathname || "/").replace(/\/+$/, "") || "/";
			return `${u.protocol}//${u.host.toLowerCase()}${p}`;
		} catch {
			return null;
		}
	}

	return null;
}

export async function fetchThreadMailSubscriptions(opts: {
	ownerId: string;
	messages: Array<{ id: string; headersJson: any }>;
}) {
	const keysByMessageId = new Map<string, string>();

	for (const m of opts.messages) {
		const key = subscriptionKeyFromHeadersJson(m.headersJson);
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
				eq(mailSubscriptions.ownerId, opts.ownerId),
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


export async function oneClickUnsubscribe(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData);
		const id = String(decodedForm.mailSubscriptionId);
		const [sub] = await db
			.select()
			.from(mailSubscriptions)
			.where(and(eq(mailSubscriptions.id, id)))
			.limit(1);
		if (!sub?.unsubscribeHttpUrl) return { success: false, error: "Subscription not found" };
		await fetch(sub.unsubscribeHttpUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "follow",
		});
		await db
			.update(mailSubscriptions)
			.set({
				status: "unsubscribed",
				unsubscribedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(mailSubscriptions.id, id));
		revalidatePath(String(decodedForm.pathname));
		return { success: true };
	});



}


