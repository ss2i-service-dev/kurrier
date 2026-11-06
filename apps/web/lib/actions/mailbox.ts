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
import { searchFilters, SEARCH_EXCLUDED_KINDS } from "@/lib/search-scope";
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

		// ss2i : identite et dossier dans le message (journal serveur) pour retrouver la requete fautive.
		// ss2i : une URL ne doit jamais bloquer (Samuel, 04/11 : precedent ou F5 laissaient sur une
		// page cassee) : identite inconnue -> accueil de la messagerie, dossier inconnu (undefined,
		// clients, dossier supprime, vieux lien) -> Inbox de l'identite.
		if (!identity) {
			console.warn(`[fetchMailbox] Identity not found: identity=${identityPublicId} slug=${mailboxSlug}, redirection`);
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
			console.warn(`[fetchMailbox] Mailbox not found: identity=${identityPublicId} slug=${mailboxSlug}, redirection`);
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
					// ss2i : le dossier Drafts est affiche (brouillons IMAP).
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
				// ss2i : la corbeille n'affiche pas de compteur de non lus.
				.innerJoin(
					mailboxes,
					and(
						eq(mailboxes.id, mailboxThreads.mailboxId),
						ne(mailboxes.kind, "trash"),
					),
				)
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

// ss2i : Content-Disposition attachment avec nom ASCII de repli et nom UTF-8 (RFC 6266).
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
			// ss2i : seconde URL pour la fleche de telechargement. L'URL S3 est d'une autre
			// origine, l'attribut download de <a> y est ignore : seul un Content-Disposition
			// attachment force l'enregistrement dans Telechargements au lieu de l'ouverture.
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
	// ss2i (controle d'acces) : action publique par nature, reservee aux utilisateurs connectes.
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
	// L'utilisateur qui envoie : c'est son carnet d'adresses que le worker alimente.
	const sender = await isSignedIn();
	if (!sender?.id) return { success: false, error: "Unauthorized" };
	decodedForm.senderUserId = sender.id;

	// ss2i (controle d'acces) : ce que le formulaire designe ne part au worker qu'une fois
	// relu. Message d'origine : visible par l'utilisateur, sinon une reponse est refusee et un
	// transfert part sans citation ni rattachement (comme le faisait deja le worker pour un
	// message introuvable). Pieces jointes : deposees par l'utilisateur ou pieces d'un message
	// du workspace. Brouillon : visible par lui. Champs reserves a l'API et aux mails
	// automatiques : retires.
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
	// ss2i : un destinataire sans adresse (« dev ») etait ignore a l'envoi sans rien dire.
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

	// ss2i : annulation d'envoi. Le job part avec un delai : l'interface propose « Undo »
	// (retrait du job) et « Send now » (promotion du job) pendant ce delai. Cote serveur,
	// donc fermer l'onglet n'empeche pas l'envoi.
	// Delai choisi par l'utilisateur (Parametres > Redaction), 0 = envoi immediat.
	const undoMs = (await undoSendSeconds()) * 1000;
	const { sendMailQueue } = await getRedis();
	const job = await sendMailQueue.add("send-and-reconcile", decodedForm, {
		jobId: `undo-send-${crypto.randomUUID()}`,
		delay: undoMs,
	});
	// Le brouillon d'origine porte la marque « envoi en cours » (liste Drafts, ouverture).
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

// ss2i : le brouillon n'est touche que s'il est visible de l'utilisateur (RLS).
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

// ss2i (controle d'acces) : un envoi en attente n'est touche que si son identite d'envoi est
// visible de l'utilisateur (RLS) ; sinon tout se passe comme si le job n'existait pas.
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

// ss2i : « Undo » d'un envoi encore en attente. Rend le formulaire si le job a bien ete
// retire ; s'il est deja parti (ou en cours d'envoi), on ne peut plus rien faire.
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

// ss2i : « Send now » : le job en attente part tout de suite.
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
		// deja parti
	}
}

// ss2i : resultat de l'envoi, appele une fois le delai ecoule (ou apres « Send now »)
// pour afficher une erreur eventuelle. Jamais pendant le delai : les actions serveur
// d'un onglet passent une par une, attendre ici bloquerait toutes les autres.
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
	// ss2i : recherche etendue a tous les dossiers de l'identite (sauf Corbeille, Spam, Outbox),
	// proposee par la modale quand le dossier courant ne donne rien (Samuel le 06/11).
	allFolders = false,
): Promise<SearchThreadsResponse> => {
	const q = query.trim();
	if (!q) {
		return { items: [], totalThreads: 0, totalMessages: 0 };
	}

	// ss2i (controle d'acces) : identite et workspace du filtre relus par RLS, jamais ceux du
	// client (il pouvait chercher dans n'importe quelle boite). Le dossier reste celui de la
	// page ; un slug (encodeURIComponent ou slugify) ne contient jamais ces caracteres, qui
	// permettraient de sortir de la valeur du filtre Typesense.
	const identity = await assertIdentityAccess({ publicId: identityPublicId });
	const workspace = await fetchWorkspace();
	if (!workspace || workspace.id !== identity.workspaceId) {
		throw new Error("Identity not found or access denied");
	}
	// Dossiers de l'identite (relus par RLS) : slugs a exclure et nom affiche de chaque resultat
	// en recherche etendue.
	let folderNames = new Map<string, string>();
	let excludeSlugs: string[] = [];
	if (allFolders) {
		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.select({ slug: mailboxes.slug, name: mailboxes.name, kind: mailboxes.kind })
				.from(mailboxes)
				.where(eq(mailboxes.identityId, identity.id)),
		);
		for (const r of rows as Array<{ slug?: string | null; name?: string | null; kind?: string | null }>) {
			if (!r.slug) continue;
			if (SEARCH_EXCLUDED_KINDS.includes(String(r.kind))) excludeSlugs.push(r.slug);
			else folderNames.set(r.slug, r.name || r.slug);
		}
	}

	const filters = searchFilters({
		workspacePublicId: workspace.publicId,
		identityPublicId: identity.publicId,
		mailboxSlug: allFolders ? null : String(mailboxSlug ?? ""),
		excludeSlugs,
		hasAttachment,
		onlyUnread,
		starred,
	});
	if (!filters) {
		return { items: [], totalThreads: 0, totalMessages: 0 };
	}

	const client = getTypeSenseClient();

	const result = (await client.collections("messages").documents().search({
		q,
		// ss2i : fromDomain interroge, sinon un domaine seul ("tdsynnex.com") ne trouve rien :
		// Typesense retire les symboles et indexe "x-y@tdsynnex.com" comme un seul mot.
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
			mailboxSlug: d.mailboxSlug ?? null,
			mailboxName: allFolders ? (folderNames.get(d.mailboxSlug) ?? d.mailboxSlug ?? null) : null,
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

		// ss2i (controle d'acces) : dossier visible et fils de ce dossier seulement.
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

	// ss2i (controle d'acces) : dossier visible et fils de ce dossier seulement.
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

// ss2i (controle d'acces) : message (deplacement au grain du message) present dans le dossier.
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

// ss2i (OI 10286) : un dossier synchronise en IMAP est toujours deplace sur le serveur, quoi
// qu'ait charge la page. La recherche, les libelles et la vue Clients n'ont pas l'etat de
// synchronisation du dossier : ils envoyaient moveImap=false et la corbeille partait « base
// seule » (base et IMAP divergeaient). Le worker applique la meme regle (moveMail) ; ici elle
// vaut aussi pour la creation du dossier Archive et la suppression definitive.
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

	// ss2i (controle d'acces) : dossier visible et fils de ce dossier seulement ; un message
	// precis (messageId) doit etre dans ce dossier, sinon le worker n'aurait rien deplace.
	const { mailbox: source, threadIds: ids } = await assertThreadsInMailbox(mailboxId, requestedIds);
	moveImap = shouldMoveImap(moveImap, await imapSynced(source.id));

	// ss2i : depuis la corbeille, « supprimer » ne peut pas etre un deplacement vers la
	// corbeille (le job ne faisait rien et l'interface annoncait « moved to Trash ») :
	// c'est une suppression definitive, comme le bouton de l'en-tete de liste.
	if (source.kind === "trash") {
		await deleteForever(ids, source.id, moveImap, refresh);
		return "deleted" as const;
	}
	if (!ids.length || (messageId && !(await messageInMailbox(messageId, source.id)))) {
		return "trashed" as const;
	}

	const { smtpQueue, searchIngestQueue } = await getRedis();

	// ss2i : un seul job pour toute la selection (cf. moveMail, worker) : un job par fil,
	// traites un a un avec chacun son aller-retour IMAP, faisait disparaitre la selection
	// au compte-gouttes.
	await smtpQueue.add(
		"mail:move",
		{ threadId: ids[0], threadIds: ids, mailboxId: source.id, op: "trash", messageId, moveImap },
		{
			// ss2i (OI 10286) : le worker fait echouer le job quand le serveur IMAP n'a pas deplace
			// les messages (remis dans la source en base) ; 8 essais espaces de 5 s, 10 s, 20 s...
			// couvrent un redemarrage de Stalwart (3 essais en 4,5 s n'y suffisaient pas).
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
	const requestedIds = (Array.isArray(threadIds) ? threadIds : [threadIds])
		.map(String)
		.filter(Boolean);
	if (!requestedIds.length || !mailboxId) return;

	// ss2i (controle d'acces) : dossier visible et fils de ce dossier seulement.
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

	// ss2i : un seul job pour toute la selection (cf. moveMail, worker) : un job par fil,
	// traites un a un avec chacun son aller-retour IMAP, faisait disparaitre la selection
	// au compte-gouttes.
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
	// ss2i (controle d'acces) : dossier visible et fil de ce dossier seulement.
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

	// ss2i : etat d'envoi des brouillons de la page (envoi en cours, echec), lu dans
	// meta.draft des lignes du dossier ; seuls les fils concernes portent `draftSend`.
	// Chaque fil qui contient un brouillon porte aussi `draftTimes` (creation et derniere
	// edition), affiche dans le dossier Drafts (son slug suit le nom du dossier IMAP).
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
				// Un envoi en cours prime sur une ancienne erreur du meme fil.
				if ((state.pendingSend || state.sendError) && (!t.draftSend || state.pendingSend))
					t.draftSend = state;
				const times = draftTimesOf({ ...d, metaData: { draft: d.meta } });
				// Plusieurs brouillons dans un fil : le plus recemment edite.
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

	// ss2i : controle d'acces repris de l'amont (kurrier-org d533d672, CWE-306) :
	// utilisateur connecte, boite visible par lui (RLS), fils de cette boite seulement.
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
	// ss2i (controle d'acces) : identite visible (RLS) ; dossier parent de cette identite.
	// Le mode IMAP suit l'identite relue (le formulaire envoyait son smtpAccountId).
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
	// ss2i (controle d'acces) : utilisateur connecte, dossier visible (RLS), et identite de
	// l'URL qui est bien celle du dossier ; avant, n'importe quel mailboxId etait supprime.
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
	// ss2i : l'amont oubliait le segment /w/<id>/, d'ou une 404 apres chaque suppression.
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

	// ss2i (controle d'acces) : dossiers source et destination visibles, de la meme identite
	// (le worker ne cherchait la destination que dans l'identite de la source), fils et
	// message de la source seulement.
	const { mailbox: from, threadIds: ids } = await assertThreadsInMailbox(fromMailboxId, requestedIds);
	const to = await assertMailboxAccess(toMailboxId);
	if (!ids.length || to.identityId !== from.identityId) return;
	if (messageId && !(await messageInMailbox(messageId, from.id))) return;
	fromMailboxId = from.id;
	toMailboxId = to.id;
	moveImap = shouldMoveImap(moveImap, await imapSynced(from.id));

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


// ss2i : meme cle que l'ingestion du worker (@common list-unsubscribe), List-Id compris :
// avant, la cle ignorait list.id et un routeur partage (Mailjet) fusionnait tous ses clients.
function subscriptionKeyFromMessage(m: { headersJson: any; from?: any }) {
	const fromEmail = String(m.from?.value?.[0]?.address ?? "").trim().toLowerCase() || null;
	return subscriptionKeyOf(extractListUnsubscribe(m.headersJson), fromEmail);
}

export async function fetchThreadMailSubscriptions(opts: {
	ownerId: string;
	messages: Array<{ id: string; headersJson: any; from?: any }>;
}) {
	// ss2i (controle d'acces) : abonnements de l'utilisateur connecte seulement ; l'ownerId
	// passe par l'appelant (client compris : c'est une action) n'est plus utilise.
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
