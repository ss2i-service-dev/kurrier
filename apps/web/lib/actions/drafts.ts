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
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { rlsClient } from "@/lib/actions/clients";
import { getRedis } from "@/lib/actions/get-redis";

// Drafts. The database is updated on every save (composer debounce); the IMAP version
// follows through the worker `draft:sync` job, at a slower pace (see
// packages/common/src/drafts.ts and apps/worker/lib/drafts/draft-service.ts).

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
	quoteScope?: string | null;
	quoteMode?: string | null;
	quoteHtml?: string | null;
};

export type SaveDraftResult =
	| { draftMessageId: string; savedAt: string; createdAt?: string; error?: undefined }
	| { error: string; draftMessageId?: undefined; savedAt?: undefined; createdAt?: undefined };

// The identity by its public id, through RLS: this is the access check.
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
			quoteScope: payload.quoteScope,
			quoteMode: payload.quoteMode,
			quoteHtml: payload.quoteHtml,
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

		return {
			draftMessageId: saved.id,
			savedAt: saved.savedAt.toISOString(),
			createdAt: saved.createdAt,
		};
	} catch (err: any) {
		return { error: err?.message ?? "Draft could not be saved." };
	}
}

// "Save draft" and closing the composer: the IMAP version is sent without waiting.
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

// Discard: permanent deletion (database then IMAP), like Gmail, Thunderbird or Roundcube;
// a draft does not go through the trash.
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
	// Sidebar Drafts counter and lists: the client receives the updated tree.
	revalidatePath("/", "layout");
	return { deleted: true as const };
}

// Original message of a reply or forward draft, to prefill the editor.
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

// Number of drafts per Drafts mailbox (sidebar counter).
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
			.where(
				and(
					inArray(messages.mailboxId, ids),
					eq(messages.draft, true),
					// A pending send (meta.draft.pendingSend) is no longer a draft.
					sql`coalesce(jsonb_typeof(${messages.metaData}->'draft'->'pendingSend'), 'null') = 'null'`,
				),
			)
			.groupBy(messages.mailboxId),
	);
	for (const r of rows) counts.set(r.mailboxId, Number(r.n ?? 0));
	return counts;
});

export type FetchDraftCountsResult = Awaited<
	ReturnType<typeof fetchDraftCounts>
>;
