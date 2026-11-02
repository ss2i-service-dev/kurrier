"use server";

import {
	DRAFT_DELETE_JOB,
	DRAFT_SYNC_JOB,
	type DraftAttachment,
	type DraftMode,
	deleteDraftRow,
	draftDeleteJobOptions,
	draftSyncJobOptions,
	upsertDraftRow,
} from "@common";
import { identities, type MessageEntity, mailboxes, messages } from "@db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { rlsClient } from "@/lib/actions/clients";
import { getRedis } from "@/lib/actions/get-redis";

// ss2i : brouillons. La base est mise a jour a chaque enregistrement (anti-rebond du
// composeur) ; la version IMAP suit par le job `draft:sync` du worker, a un rythme plus
// lent (cf. packages/common/src/drafts.ts et apps/worker/lib/drafts/draft-service.ts).

export type DraftFormPayload = {
	identityPublicId: string;
	draftMessageId?: string | null;
	to?: string[] | string | null;
	cc?: string[] | string | null;
	bcc?: string[] | string | null;
	subject?: string | null;
	html?: string | null;
	text?: string | null;
	mode?: DraftMode | string | null;
	originalMessageId?: string | null;
	attachments?: DraftAttachment[] | string | null;
	includeSignature?: boolean | string | null;
};

export type SaveDraftResult =
	| { draftMessageId: string; savedAt: string; error?: undefined }
	| { error: string; draftMessageId?: undefined; savedAt?: undefined };

// L'identite par son identifiant public, a travers RLS : c'est le controle d'acces.
async function identityFor(identityPublicId: string) {
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx
			.select()
			.from(identities)
			.where(eq(identities.publicId, identityPublicId))
			.limit(1),
	);
	return identity ?? null;
}

export async function saveDraft(
	payload: DraftFormPayload,
): Promise<SaveDraftResult> {
	try {
		const identity = await identityFor(String(payload.identityPublicId ?? ""));
		if (!identity) return { error: "Identity not found." };

		const mode: DraftMode =
			payload.mode === "reply" || payload.mode === "forward"
				? payload.mode
				: "new";
		const saved = await upsertDraftRow({
			ownerId: identity.ownerId,
			identityId: identity.id,
			draftMessageId: payload.draftMessageId || null,
			to: payload.to,
			cc: payload.cc,
			bcc: payload.bcc,
			subject: payload.subject,
			html: payload.html,
			text: payload.text,
			mode,
			originalMessageId: payload.originalMessageId || null,
			attachments: payload.attachments,
			includeSignature: payload.includeSignature,
		});

		const { smtpQueue } = await getRedis();
		if (saved.replaced) {
			await smtpQueue.add(
				DRAFT_DELETE_JOB,
				saved.replaced,
				draftDeleteJobOptions(),
			);
		}
		await smtpQueue.add(
			DRAFT_SYNC_JOB,
			{ draftMessageId: saved.id },
			draftSyncJobOptions(saved.id),
		);

		return { draftMessageId: saved.id, savedAt: saved.savedAt.toISOString() };
	} catch (err: any) {
		return { error: err?.message ?? "Draft could not be saved." };
	}
}

// « Save draft » et fermeture du composeur : la version IMAP part sans attendre.
export async function flushDraft(
	identityPublicId: string,
	draftMessageId: string,
) {
	const identity = await identityFor(identityPublicId);
	if (!identity || !draftMessageId) return;
	const [row] = await (await rlsClient())((tx) =>
		tx
			.select({ id: messages.id })
			.from(messages)
			.where(and(eq(messages.id, draftMessageId), eq(messages.draft, true)))
			.limit(1),
	);
	if (!row) return;
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(
		DRAFT_SYNC_JOB,
		{ draftMessageId },
		draftSyncJobOptions(draftMessageId, 0),
	);
}

// Abandon : suppression definitive (base puis IMAP), comme Gmail, Thunderbird ou Roundcube ;
// un brouillon ne passe pas par la corbeille.
export async function discardDraft(
	identityPublicId: string,
	draftMessageId: string,
) {
	const identity = await identityFor(identityPublicId);
	if (!identity)
		return { deleted: false as const, error: "Identity not found." };
	const ref = await deleteDraftRow({
		ownerId: identity.ownerId,
		draftMessageId,
	});
	if (!ref) return { deleted: false as const };
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(DRAFT_DELETE_JOB, ref, draftDeleteJobOptions());
	return { deleted: true as const };
}

// Message d'origine d'un brouillon de reponse ou de transfert, pour pre-remplir l'editeur.
export const fetchDraftOriginal = cache(
	async (
		originalMessageId: string | null | undefined,
	): Promise<MessageEntity | null> => {
		if (!originalMessageId) return null;
		const rls = await rlsClient();
		const [row] = await rls((tx) =>
			tx
				.select()
				.from(messages)
				.where(eq(messages.id, originalMessageId))
				.limit(1),
		);
		return (row as MessageEntity | undefined) ?? null;
	},
);

// Nombre de brouillons par dossier Drafts (compteur de la barre laterale).
export const fetchDraftCounts = cache(async () => {
	const rls = await rlsClient();
	const draftBoxes = await rls((tx) =>
		tx
			.select({ id: mailboxes.id })
			.from(mailboxes)
			.where(eq(mailboxes.kind, "drafts")),
	);
	const ids = draftBoxes.map((b) => b.id);
	const counts = new Map<string, number>();
	if (!ids.length) return counts;
	const rows = await rls((tx) =>
		tx
			.select({ mailboxId: messages.mailboxId, n: sql<number>`count(*)` })
			.from(messages)
			.where(and(inArray(messages.mailboxId, ids), eq(messages.draft, true)))
			.groupBy(messages.mailboxId),
	);
	for (const r of rows) counts.set(r.mailboxId, Number(r.n ?? 0));
	return counts;
});

export type FetchDraftCountsResult = Awaited<
	ReturnType<typeof fetchDraftCounts>
>;
