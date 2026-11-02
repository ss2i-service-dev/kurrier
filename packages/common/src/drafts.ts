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
import { addressObjToList } from "./mail-client";

export { addressObjToList };

/**
 * ss2i : brouillons, couche base de donnees (partagee par le web et le worker).
 *
 * Un brouillon est une ligne `messages` du dossier `drafts` de l'identite, `draft = true`,
 * dont `meta.draft` porte ce que l'editeur doit retrouver (mode, message d'origine, pieces
 * jointes, revision) et `meta.imap` la version poussee dans le dossier IMAP Drafts.
 *
 * - `revision` s'incremente a chaque enregistrement ; `imapRevision` est la derniere
 *   revision poussee en IMAP (worker, lib/drafts/draft-service.ts). Les deux egales :
 *   rien a pousser.
 * - `draftId` est stable d'une version a l'autre (en-tete X-Kurrier-Draft-Id du MIME) ;
 *   le Message-ID change a chaque version poussee, Gmail dedoublonnant par Message-ID.
 */

export const DRAFT_SYNC_JOB = "draft:sync";
export const DRAFT_DELETE_JOB = "draft:delete";
// Cadence de la version IMAP : la base est a jour a chaque frappe (3 s), le dossier
// IMAP suit a ce rythme-ci. Chaque version poussee en remplace une ; chez Gmail la version
// supprimee peut transiter par la corbeille, d'ou un rythme lent.
export const DRAFT_IMAP_DEBOUNCE_MS = 45_000;

// Options BullMQ du job `draft:sync` (file smtp-worker), memes cote web et cote worker :
// un seul job en attente par brouillon pendant la fenetre, les enregistrements suivants
// sont absorbes (le job lit l'etat de la base quand il tourne). delayMs = 0 : tout de suite.
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
	revision: number;
	imapRevision?: number;
	savedAt?: string;
};

export type DraftInput = {
	ownerId: string;
	identityId: string;
	// Ligne existante a mettre a jour ; absent = nouveau brouillon.
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
};

// Ce qu'il faut pour retrouver la version IMAP d'un brouillon une fois la ligne supprimee.
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

// « Nom <adresse> » ou « adresse » -> objet d'adresses tel que le stocke `messages`.
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
 * Enregistre (cree ou met a jour) un brouillon en base et rafraichit la ligne du dossier
 * Drafts. Ne touche pas a IMAP : c'est le job `draft:sync` du worker qui pousse la version.
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

	// L'expediteur (From) a change d'identite : le brouillon change de dossier Drafts. On
	// repart d'une ligne neuve et l'appelant supprime l'ancienne version IMAP (`replaced`).
	let replaced: DraftImapRef | null = null;
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

	// Message d'origine (reponse ou transfert) : fil et en-tetes de reference.
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

	const inReplyTo = mode === "reply" && orig ? orig.messageId : null;
	const references =
		mode === "reply" && orig
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
	const html = input.html ?? "";
	const text = input.text ?? "";
	const subject = (input.subject ?? "").trim();
	const now = new Date();
	const revision = (prevMeta?.revision ?? 0) + 1;
	const draftId = prevMeta?.draftId ?? crypto.randomUUID();

	const draftMeta: DraftMeta = {
		...(prevMeta ?? {}),
		draftId,
		mode,
		originalMessageId,
		attachments,
		includeSignature,
		revision,
		savedAt: now.toISOString(),
	};

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
		// `meta.imap` (version IMAP) est mis a jour par le worker, parfois en meme temps :
		// on ne reecrit que la cle `draft`, jamais le jsonb entier.
		const [updated] = await db
			.update(messages)
			.set({
				...fields,
				metaData: sql`jsonb_set(coalesce(${messages.metaData}, '{}'::jsonb), '{draft}', ${JSON.stringify(draftMeta)}::jsonb, true)`,
			})
			.where(eq(messages.id, existing.id))
			.returning();
		row = updated as DraftRow;
	} else {
		const threadId = await db.transaction(async (tx) => {
			if (mode === "reply" && orig?.threadId) return orig.threadId;
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
	// L'upsert accumule (OR) la presence de pieces jointes et garde l'ancien extrait quand le
	// nouveau est vide : pour le dossier Drafts, on reflete l'etat courant.
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
 * Supprime le brouillon en base (ligne, resume du dossier Drafts, fil s'il est vide) et
 * rend de quoi supprimer sa version IMAP. Null si la ligne n'existe pas (ou plus).
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
 * Charge utile d'envoi d'un brouillon, de la forme que `send-and-reconcile` attend
 * (celle du formulaire du composeur, cf. apps/web/lib/actions/mailbox.ts sendMail).
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
		newMessageId: crypto.randomUUID(),
		draftMessageId: row.id,
	};
}
