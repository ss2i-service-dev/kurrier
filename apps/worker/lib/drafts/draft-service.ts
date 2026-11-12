/**
 * ss2i : service des brouillons (worker). Un brouillon est une ligne `messages` du dossier
 * Drafts de l'identite (cf. packages/common/src/drafts.ts pour la couche base) et un
 * message MIME `\Draft` dans le dossier IMAP Drafts, suivi par l'en-tete X-Kurrier-Draft-Id.
 *
 * Interface (toutes les fonctions prennent ownerId + identityId ; prevue pour le serveur MCP) :
 *
 *   saveDraft({ ownerId, identityId, draftMessageId?, to, cc, bcc, subject, html, text,
 *               mode, originalMessageId, attachments, includeSignature })
 *     -> { draftMessageId, draftId, revision, savedAt }
 *     Base a jour tout de suite ; la version IMAP suit par le job `draft:sync` (file
 *     smtp-worker), differe de DRAFT_IMAP_DEBOUNCE_MS, un seul en attente par brouillon.
 *   flushDraft({ draftMessageId })               -> pousse la version IMAP sans attendre.
 *   listDrafts({ ownerId, identityId, limit?, offset? }) -> DraftSummary[]
 *   getDraft({ ownerId, identityId, draftMessageId })    -> DraftDetail | null
 *   deleteDraft({ ownerId, identityId, draftMessageId }, imapInstances?)
 *     Supprime en base puis en IMAP (sur place si on a les connexions, sinon par le job
 *     `draft:delete`). Suppression definitive, pas de passage par la corbeille : c'est la
 *     convention des clients (Gmail, Thunderbird, Roundcube) pour un brouillon.
 *   sendDraft({ ownerId, identityId, draftMessageId, delayMs?, sendAt?, senderUserId? })
 *     -> { pendingSendId, undoMs, scheduledAt? }
 *     Meme chemin que le composeur (job `send-and-reconcile`, differe et annulable) ; le
 *     brouillon est supprime par send-mail.ts une fois l'envoi reussi. Avec `sendAt` (envoi
 *     programme) : ligne draft_messages « scheduled » + job `send-scheduled-draft` differe,
 *     comme le menu « Programmer l'envoi » du composeur ; le brouillon porte la marque
 *     pendingSend jusqu'a l'heure (annulable depuis courrier).
 *
 * Jobs (file smtp-worker, un a la fois, donc jamais deux APPEND concurrents) :
 *   draft:sync   { draftMessageId }   -> syncDraftToImap
 *   draft:delete DraftImapRef         -> deleteDraftFromImap
 *
 * Remplacement d'une version : APPEND de la nouvelle (UID par APPENDUID, sinon recherche par
 * Message-ID), suppression de l'ancienne par UID verifie, puis des orphelins portant le meme
 * X-Kurrier-Draft-Id ; mise a jour de la base sous le verrou du dossier. Chez Gmail, la
 * version supprimee peut reapparaitre dans [Gmail]/Corbeille : on l'y purge (au mieux).
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
	pendingSendAlive,
	scheduledJobOf,
	scheduledPendingSend,
	validateScheduledAt,
	draftSyncJobOptions,
	getDraftRow,
	listDraftRows,
	setDraftSendState,
	upsertDraftRow,
} from "@common";
import { db, draftMessages, identities, mailboxes, messages } from "@db";
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

// Un seul job de synchro en attente par brouillon : les enregistrements suivants, dans la
// fenetre, sont absorbes (le job lit l'etat de la base au moment ou il tourne).
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
	opts: {
		ownerId: string;
		identityId: string;
		draftMessageId: string;
		// Nettoyage apres un envoi reussi : la garde « envoi en attente » ne s'applique pas.
		afterSend?: boolean;
	},
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
	// Envoi programme : heure d'envoi (a verifier par l'appelant, revalidee ici).
	sendAt?: Date;
	senderUserId?: string | null;
}) {
	const payload = await draftSendPayload(opts);
	if (payload.identityId !== opts.identityId)
		throw new Error("Draft not found");
	// Un envoi deja en attente (delai d'annulation ou programme) n'est pas redouble ; une marque
	// perimee de plus de 3 minutes (etat inconnu de l'interface) ne bloque plus.
	const row = await getDraftRow(opts);
	if (pendingSendAlive(row ? draftMetaOf(row)?.pendingSend : null)) {
		throw new Error("This draft already has a send in progress; cancel it from courrier first.");
	}
	const { sendMailQueue } = await getRedis();
	if (opts.sendAt) {
		const check = validateScheduledAt(opts.sendAt);
		if (!check.ok) {
			throw new Error(
				check.reason === "past" ? "send_at is in the past." : "send_at is not a valid date.",
			);
		}
		const [identity] = await db
			.select({ workspaceId: identities.workspaceId })
			.from(identities)
			.where(eq(identities.id, payload.identityId));
		if (!identity) throw new Error("Identity not found");
		const [created] = await db
			.insert(draftMessages)
			.values({
				ownerId: opts.ownerId,
				workspaceId: identity.workspaceId,
				identityId: payload.identityId,
				mailboxId: payload.mailboxId,
				status: "scheduled",
				scheduledAt: check.at,
				payload,
			})
			.returning({ id: draftMessages.id, scheduledAt: draftMessages.scheduledAt });
		const job = scheduledJobOf({
			id: created.id,
			identityId: payload.identityId,
			scheduledAt: created.scheduledAt,
			payload,
		});
		try {
			await sendMailQueue.add(job.name, job.data, job.opts);
		} catch (e) {
			// Sans job, la ligne ne partirait qu'au prochain demarrage du worker : on la retire.
			await db.delete(draftMessages).where(eq(draftMessages.id, created.id));
			throw e;
		}
		try {
			await setDraftSendState(opts.draftMessageId, {
				pendingSend: scheduledPendingSend(created),
				sendError: null,
			});
		} catch (e) {
			// Sans marque, le brouillon resterait modifiable et l'envoi invisible : on retire le job
			// et la ligne plutot que de laisser un envoi programme sans marque.
			await (await sendMailQueue.getJob(created.id))?.remove().catch(() => {});
			await db.delete(draftMessages).where(eq(draftMessages.id, created.id));
			throw new Error(
				`Scheduling failed, nothing was scheduled: ${(e as Error)?.message ?? e}`,
			);
		}
		return {
			pendingSendId: created.id,
			undoMs: job.opts.delay,
			scheduledAt: check.at.toISOString(),
		};
	}
	const delay = opts.delayMs ?? UNDO_SEND_MS;
	const job = await sendMailQueue.add("send-and-reconcile", payload, {
		jobId: `undo-send-${crypto.randomUUID()}`,
		delay,
	});
	// Marque « envoi en cours » : la liste Drafts et l'ouverture du brouillon l'affichent.
	await setDraftSendState(opts.draftMessageId, {
		pendingSend: {
			jobId: String(job.id),
			sendAt: new Date(Date.now() + delay).toISOString(),
		},
		sendError: null,
	});
	return { pendingSendId: String(job.id), undoMs: delay, scheduledAt: undefined };
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
				`[draft] piece jointe illisible ${att.path}:`,
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

// Gmail : une suppression dans Drafts peut laisser une copie dans la corbeille (selon le
// reglage IMAP du compte). On l'y cherche par Message-ID et on la supprime ; au mieux.
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
			`[draft] purge corbeille Gmail impossible:`,
			err?.message ?? err,
		);
	}
}

// Versions a supprimer dans le dossier courant : l'UID connu (verifie par Message-ID) et
// tout orphelin portant le meme X-Kurrier-Draft-Id. A appeler verrou tenu.
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
 * Pousse l'etat courant du brouillon dans le dossier IMAP Drafts et retire la version
 * precedente. Sans effet si rien n'a change depuis la derniere version poussee.
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

	// Identite sans compte IMAP : la base fait foi, rien a pousser.
	if (!identity.smtpAccountId) {
		await markSynced();
		return;
	}

	const path = String((box.metaData as any)?.imap?.path ?? box.name ?? "");
	if (!path)
		throw new Error(
			`[draft] dossier Drafts sans chemin IMAP (mailbox ${box.id})`,
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
			`[draft] connexion IMAP indisponible (identite ${identity.id})`,
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
			// Sans UIDPLUS : retrouver la version qu'on vient d'ecrire par son Message-ID.
			const found = await resolveUids(client, [
				{ id: "new", uid: 0, messageId: newMessageId },
			]);
			newUid = [...found.keys()].sort((a, b) => b - a)[0];
		}

		// Ancienne version et orphelins, dans ce dossier.
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

		// Brouillon envoye ou abandonne pendant l'APPEND : la version ecrite est de trop.
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

/** Supprime la version IMAP d'un brouillon deja retire de la base. */
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
			`[draft] connexion IMAP indisponible (identite ${ref.identityId})`,
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
