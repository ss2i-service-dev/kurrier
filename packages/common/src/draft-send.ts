// Send state of a draft (meta.draft.pendingSend / sendError), the pure part of
// drafts.ts (testable without a database, see apps/worker/test/draft-send.ts).

export type DraftPendingSend = { jobId: string; sendAt: string };
export type DraftSendError = { message: string; at: string };

export type DraftSendFields = {
	pendingSend?: DraftPendingSend;
	sendError?: DraftSendError;
	quoteMode?: unknown;
	quoteHtml?: unknown;
};

// Merge of meta.draft on save: the send state (pendingSend) is kept as-is by an autosave
// update and is only changed by setDraftSendState. An edit after a failed send clears
// sendError (the error message is stale).
export function mergeDraftMeta<M extends DraftSendFields>(
	prev: M | null,
	next: M,
): M {
	const merged = {
		...(prev ?? {}),
		quoteMode: undefined,
		quoteHtml: undefined,
		...next,
	} as M;
	delete merged.sendError;
	if (prev?.pendingSend) merged.pendingSend = prev.pendingSend;
	else delete merged.pendingSend;
	return merged;
}

// Send state of a draft, as read by the list and when opening it.
export type DraftSendState = {
	pendingSend: DraftPendingSend | null;
	sendError: DraftSendError | null;
};

export const draftSendStateOf = (
	meta: DraftSendFields | null | undefined,
): DraftSendState => ({
	pendingSend: meta?.pendingSend ?? null,
	sendError: meta?.sendError ?? null,
});

export type DraftTimes = { createdAt: string | null; savedAt: string | null };

// Creation and last-edit times of a draft. Drafts older than meta.draft.createdAt, or
// coming from another client over IMAP, take the creation time of the row.
export function draftTimesOf(row: {
	metaData: Record<string, any> | null;
	createdAt?: Date | string | null;
	updatedAt?: Date | string | null;
	date?: Date | string | null;
}): DraftTimes {
	const meta = (row.metaData as any)?.draft ?? null;
	const iso = (v: Date | string | null | undefined) =>
		v == null ? null : v instanceof Date ? v.toISOString() : String(v);
	const createdAt = meta?.createdAt ?? iso(row.createdAt) ?? iso(row.date);
	const savedAt = meta?.savedAt ?? iso(row.updatedAt) ?? iso(row.date) ?? createdAt;
	return { createdAt, savedAt };
}
