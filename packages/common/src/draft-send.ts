// ss2i : etat d'envoi d'un brouillon (meta.draft.pendingSend / sendError), partie pure de
// drafts.ts (testable sans base, cf. apps/worker/test/draft-send.ts).

export type DraftPendingSend = { jobId: string; sendAt: string };
export type DraftSendError = { message: string; at: string };

export type DraftSendFields = {
	pendingSend?: DraftPendingSend;
	sendError?: DraftSendError;
	quoteMode?: unknown;
	quoteHtml?: unknown;
};

// Fusion de meta.draft a l'enregistrement : l'etat d'envoi (pendingSend) est conserve tel
// quel par une mise a jour d'autosave, il n'est modifie que par setDraftSendState. Une
// modification apres un echec d'envoi efface sendError (le message d'erreur est perime).
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

// Etat d'envoi d'un brouillon, tel que la liste et l'ouverture le lisent.
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

