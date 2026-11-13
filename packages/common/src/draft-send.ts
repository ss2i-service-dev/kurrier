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
// Envoi precedent interrompu ou coupe apres l'envoi (le serveur n'a pas repondu) : le mail est
// peut-etre parti, le brouillon ne repart pas tant que l'envoi n'est pas ecarte dans la Boite
// d'envoi (« Reessayer » y demande confirmation).
export const DRAFT_MAYBE_SENT_ERROR = "Ce mail est peut-être déjà parti : vérifiez dans la Boîte d'envoi";

// Erreur posee sur le brouillon a la fin d'un envoi en echec.
export function draftSendErrorOf(row: { acceptanceUnknown?: boolean | null }, error: string | null | undefined): string {
	if (!row.acceptanceUnknown) return String(error ?? "");
	return error ? `${DRAFT_MAYBE_SENT_ERROR}. ${error}` : DRAFT_MAYBE_SENT_ERROR;
}

// Decompte d'annulation sans resultat depuis 3 minutes : etat inconnu, la marque ne bloque plus.
export const PENDING_STALE_MS = 3 * 60_000;

// Un envoi programme a pour jobId la ligne draft_messages ; un decompte, « undo-send-<uuid> ».
export const isScheduledMark = (pending: DraftPendingSend | null | undefined) =>
	!!pending?.jobId && !pending.jobId.startsWith("undo-send-");

// Ligne ledger draft_messages designee par une marque (jobId = id de la ligne).
export type MarkLedgerRow = {
	status: string;
	acceptedAt?: Date | string | null;
	sentRowId?: string | null;
	dismissedAt?: Date | string | null;
};

// La ligne garde le brouillon verrouille : envoi en attente, en cours, ou accepte sans copie
// Envoyes encore (la finalisation supprime alors le brouillon).
const rowHoldsDraft = (row: MarkLedgerRow) =>
	!row.dismissedAt &&
	(row.status === "scheduled" ||
		row.status === "sending" ||
		(row.status === "sent" && !!row.acceptedAt && !row.sentRowId));

// Marque orpheline (ligne terminee, brouillon pas nettoye : crash apres le commit, nettoyage,
// restauration ou retrait de marque en echec) : envoye avec sa copie Envoyes -> le brouillon
// part ; echec, annulation, ligne ecartee ou ancienne ligne « sent » -> la marque seule est
// retiree, le contenu reste. Null : la ligne garde encore le brouillon.
export type SettleAction = "delete" | "unlock";
export function settleActionOf(row: MarkLedgerRow): SettleAction | null {
	if (rowHoldsDraft(row)) return null;
	return row.status === "sent" && row.sentRowId && !row.dismissedAt ? "delete" : "unlock";
}

// `row` : ligne designee par une marque d'envoi programme (undefined = non lue, null = absente).
export function pendingSendAlive(
	pending: DraftPendingSend | null | undefined,
	now: number = Date.now(),
	row?: MarkLedgerRow | null,
): boolean {
	if (!pending) return false;
	const at = Date.parse(pending.sendAt);
	if (Number.isNaN(at)) return false;
	// Un envoi programme reste vivant tant que sa ligne l'est (l'heure peut etre depassee si le
	// worker est arrete) ; une ligne terminee ou absente ne verrouille plus le brouillon.
	if (isScheduledMark(pending)) return row === undefined || (!!row && rowHoldsDraft(row));
	return at > now - PENDING_STALE_MS;
}
