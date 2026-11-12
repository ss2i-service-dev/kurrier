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

export type DraftTimes = { createdAt: string | null; savedAt: string | null };

// ss2i : heures de creation et de derniere edition d'un brouillon. Les brouillons anterieurs
// a meta.draft.createdAt, ou venus d'un autre client par IMAP, prennent la creation de la ligne.
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

// ss2i : garde « envoi en attente ». Un brouillon dont l'envoi est en attente (delai d'annulation
// ou envoi programme) ne se modifie ni ne se supprime en douce : l'envoi emporte une copie du
// contenu, une modification serait perdue sans que l'utilisateur le sache.
export const DRAFT_PENDING_ERROR = "This draft is scheduled; cancel the scheduled send first";
// Decompte d'annulation sans resultat depuis 3 minutes : etat inconnu, la marque ne bloque plus.
export const PENDING_STALE_MS = 3 * 60_000;

// Un envoi programme a pour jobId la ligne draft_messages ; un decompte, « undo-send-<uuid> ».
export const isScheduledMark = (pending: DraftPendingSend | null | undefined) =>
	!!pending?.jobId && !pending.jobId.startsWith("undo-send-");

export function pendingSendAlive(
	pending: DraftPendingSend | null | undefined,
	now: number = Date.now(),
): boolean {
	if (!pending) return false;
	const at = Date.parse(pending.sendAt);
	if (Number.isNaN(at)) return false;
	// Un envoi programme reste vivant tant que sa marque existe (l'heure peut etre depassee si
	// le worker est arrete) : seuls l'envoi, l'echec definitif et l'annulation l'effacent.
	if (isScheduledMark(pending)) return true;
	return at > now - PENDING_STALE_MS;
}
