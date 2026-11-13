// ss2i : Boite d'envoi (OI 10519). Pipeline d'envoi du worker, arbitre par la ligne ledger
// draft_messages (une ligne par envoi). Pur : base, SMTP, S3 et IMAP sont injectes (le cablage
// Drizzle est dans server/plugins/send-mail.ts, les tests dans test/send-accept-finalize.ts).
//
// Ordre, et pourquoi :
//  1. claim : CAS scheduled -> sending ; perdue (annule, deja pris), rien n'est envoye.
//  2. rendu (identite, secrets, pieces jointes, citation) hors transaction, sans ecriture.
//  3. SMTP avec le Message-ID de la ligne, hors transaction.
//  4. un seul UPDATE « accepte » (sent, accepted_at, smtp_response, rendered). Apres un 250, plus
//     rien n'ecrit « failed » : un mail parti n'est jamais propose au renvoi. Si cet UPDATE echoue,
//     la ligne reste « sending » et le balayage la passe en « interrompu ».
//  5. finalizeSent : copie Envoyes idempotente (transaction, ligne verrouillee, sent_row_id), puis
//     effets apres le commit (eml S3, recherche, CRM, contacts, suppression du brouillon).
// Jamais de renvoi automatique : un renvoi apres un 250 perdu double l'envoi.
import type { SendEmailResult } from "../../../../packages/providers/src/core";
import { mailerFailureOf } from "../send-outcome";

export type LedgerRow = {
	id: string;
	status: string;
	payload: Record<string, any>;
	identityId: string | null;
	messageId: string | null;
	acceptedAt: Date | null;
	acceptanceUnknown: boolean;
	deliveryState: string;
	rendered: Record<string, any> | null;
	sentRowId: string | null;
	updatedAt: Date;
};

// Chaque methode est un seul UPDATE ... WHERE <etat attendu> RETURNING (null = transition perdue).
export type LedgerStore = {
	get(id: string): Promise<LedgerRow | null>;
	// scheduled -> sending
	claim(id: string): Promise<LedgerRow | null>;
	// sending -> failed (last_error, acceptance_unknown, payload.__error pour les anciens lecteurs)
	fail(id: string, f: { error: string; ambiguous: boolean }): Promise<LedgerRow | null>;
	// sending, ou interrompu jamais accepte (balayage passe pendant le SMTP) -> sent
	accept(
		id: string,
		a: { messageId: string; smtpResponse: string | null; rendered: Record<string, any> },
	): Promise<LedgerRow | null>;
	// sending sans accepted_at, pas touchee depuis `before`
	staleSending(before: Date): Promise<LedgerRow[]>;
	// sent, accepted_at avant `before`, delivery_state none, sent_row_id NULL
	unfinalized(before: Date): Promise<LedgerRow[]>;
};

// Message rendu, pret a partir : `rendered` est fige sur la ligne a l'acceptation (la
// finalisation se rejoue depuis la ligne, meme apres un redemarrage du worker).
export type Prepared = {
	from: string;
	imapDraftId: string | null;
	rendered: Record<string, any>;
	send: (messageId: string) => Promise<SendEmailResult>;
};

export type SendDeps = {
	store: LedgerStore;
	render: (row: LedgerRow) => Promise<Prepared>;
	newMessageId: (from: string) => string;
	finalize: (rowId: string) => Promise<unknown>;
	// Fin d'envoi en echec sur le brouillon : marque pendingSend retiree, sendError posee.
	markFailed: (row: LedgerRow, error: string) => Promise<unknown>;
	log?: (msg: string, err?: unknown) => void;
};

export type SendOutcome =
	| { outcome: "skipped"; row: LedgerRow | null }
	| { outcome: "failed" | "interrupted"; error: string; row: LedgerRow | null }
	| { outcome: "sent"; row: LedgerRow }
	| { outcome: "unrecorded"; error: string };

const messageOf = (err: unknown) => String((err as any)?.message ?? err);

// Message-ID d'un fournisseur HTTP (SES <...@amazonses.com>, SendGrid x-message-id) : remplace
// celui de la ligne s'il differe, sinon le threading des reponses casse.
const providerMessageId = (res: SendEmailResult, ours: string) => {
	const theirs = String(res.MessageId ?? "").trim();
	if (!theirs || theirs === ours) return ours;
	return theirs.startsWith("<") ? theirs : `<${theirs}>`;
};

async function failRow(deps: SendDeps, row: LedgerRow, error: string, ambiguous: boolean): Promise<SendOutcome> {
	const log = deps.log ?? console.error;
	let failed: LedgerRow | null = null;
	try {
		failed = await deps.store.fail(row.id, { error, ambiguous });
		if (!failed) log(`[send] ${row.id}: echec non enregistre (ligne deja sortie de sending)`);
		await deps.markFailed(failed ?? row, error);
	} catch (err) {
		log(`[send] ${row.id}: enregistrement de l'echec impossible`, err);
	}
	return { outcome: ambiguous ? "interrupted" : "failed", error, row: failed };
}

export async function runSend(rowId: string, deps: SendDeps): Promise<SendOutcome> {
	const log = deps.log ?? console.error;
	const row = await deps.store.claim(rowId);
	if (!row) return { outcome: "skipped", row: await deps.store.get(rowId) };

	let prepared: Prepared;
	try {
		prepared = await deps.render(row);
	} catch (err) {
		// Avant tout SMTP : echec certain.
		return failRow(deps, row, messageOf(err), false);
	}

	const messageId = row.messageId || deps.newMessageId(prepared.from);
	let res: SendEmailResult;
	try {
		res = await prepared.send(messageId);
	} catch (err) {
		// Le mailer a leve sans rendre d'issue : on ne sait pas ou il s'est arrete.
		res = { success: false, error: messageOf(err), ambiguous: true };
	}
	if (!res.success) {
		return failRow(deps, row, mailerFailureOf(res) as string, !!res.ambiguous);
	}

	// Accepte par le serveur : a partir d'ici, plus jamais « failed ».
	let accepted: LedgerRow | null;
	try {
		accepted = await deps.store.accept(row.id, {
			messageId: providerMessageId(res, messageId),
			smtpResponse: res.response ?? null,
			rendered: prepared.rendered,
		});
	} catch (err) {
		log(`[send] ${row.id}: accepte par le serveur mais non enregistre`, err);
		return { outcome: "unrecorded", error: messageOf(err) };
	}
	if (!accepted) {
		log(`[send] ${row.id}: accepte par le serveur mais la ligne a change d'etat`);
		return { outcome: "unrecorded", error: "row changed state" };
	}
	try {
		await deps.finalize(row.id);
	} catch (err) {
		// Le balayage reprend la finalisation (accepted_at pose, sent_row_id NULL).
		log(`[send] ${row.id}: copie Envoyes reportee`, err);
	}
	return { outcome: "sent", row: accepted };
}

export type FinalizeTx = {
	// SELECT ... FOR UPDATE de la ligne ledger
	lockRow(id: string): Promise<LedgerRow | null>;
	// Fil de la reponse ou du transfert (rendered.threadId), sinon nouveau fil
	ensureThread(row: LedgerRow): Promise<string>;
	// INSERT messages ... ON CONFLICT (mailbox_id, message_id) DO NOTHING, sinon la ligne existante
	insertMessage(row: LedgerRow, threadId: string): Promise<{ id: string; inserted: boolean }>;
	insertAttachments(messageRowId: string, row: LedgerRow): Promise<unknown>;
	upsertThreadItem(messageRowId: string): Promise<unknown>;
	setSentRowId(rowId: string, messageRowId: string): Promise<unknown>;
};

export type FinalizeIo = {
	transaction<T>(fn: (tx: FinalizeTx) => Promise<T>): Promise<T>;
	// Effets non transactionnels, une fois, apres le commit ; une perte ici (crash entre le
	// commit et l'effet) n'est pas rejouee : limite connue.
	afterCommit(f: { row: LedgerRow; messageRowId: string; inserted: boolean }): Promise<unknown>;
};

export type FinalizeResult = { messageRowId: string; inserted: boolean; already: boolean } | null;

// Copie Envoyes d'une ligne acceptee, idempotente : rejouee (balayage, double appel), elle ne cree
// jamais une seconde ligne messages ; une copie IMAP arrivee avant est reprise telle quelle.
export async function finalizeSent(rowId: string, io: FinalizeIo, log = console.error): Promise<FinalizeResult> {
	const done = await io.transaction(async (tx) => {
		const row = await tx.lockRow(rowId);
		if (!row || row.status !== "sent" || !row.rendered || !row.messageId) return null;
		if (row.sentRowId) return { row, messageRowId: row.sentRowId, inserted: false, already: true };
		const threadId = await tx.ensureThread(row);
		const { id, inserted } = await tx.insertMessage(row, threadId);
		if (inserted) await tx.insertAttachments(id, row);
		await tx.upsertThreadItem(id);
		await tx.setSentRowId(row.id, id);
		return { row, messageRowId: id, inserted, already: false };
	});
	if (!done) return null;
	if (!done.already) {
		await io
			.afterCommit({ row: done.row, messageRowId: done.messageRowId, inserted: done.inserted })
			.catch((err) => log(`[send] ${rowId}: effets apres envoi`, err));
	}
	return { messageRowId: done.messageRowId, inserted: done.inserted, already: done.already };
}

export const STALE_SENDING_MS = 10 * 60_000;
export const FINALIZE_GRACE_MS = 2 * 60_000;
export const INTERRUPTED_ERROR =
	"Sending interrupted before the server answered: this message may already have been sent";

// Balayage (demarrage du worker, puis toutes les 5 minutes) : un envoi reste « sending » plus de
// 10 minutes sans acceptation -> interrompu (jamais renvoye) ; un envoi accepte depuis plus de
// 2 minutes sans copie Envoyes -> finalise.
export async function sweepLedger(
	deps: Pick<SendDeps, "store" | "finalize" | "markFailed" | "log">,
	now: Date = new Date(),
): Promise<{ interrupted: string[]; finalized: string[] }> {
	const log = deps.log ?? console.error;
	const interrupted: string[] = [];
	const finalized: string[] = [];
	for (const row of await deps.store.staleSending(new Date(now.getTime() - STALE_SENDING_MS))) {
		try {
			const failed = await deps.store.fail(row.id, { error: INTERRUPTED_ERROR, ambiguous: true });
			if (!failed) continue;
			interrupted.push(row.id);
			await deps.markFailed(failed, INTERRUPTED_ERROR);
		} catch (err) {
			log(`[send] balayage ${row.id}`, err);
		}
	}
	for (const row of await deps.store.unfinalized(new Date(now.getTime() - FINALIZE_GRACE_MS))) {
		try {
			await deps.finalize(row.id);
			finalized.push(row.id);
		} catch (err) {
			log(`[send] finalisation ${row.id}`, err);
		}
	}
	return { interrupted, finalized };
}

// Job herite « send-and-reconcile » (en vol au deploiement, ancien web, desinscription,
// invitations, API) : il recoit sa ligne ledger (origine direct) puis passe par runSend. La cle
// job.id:timestamp rend la creation idempotente si le job est rejoue (stalled).
export async function legacyLedgerRow(
	job: { id?: string | null; timestamp: number; data: Record<string, any> },
	ident: { identityId: string; fromAddress: string },
	io: {
		findByLegacyKey(key: string): Promise<{ id: string } | null>;
		insertRow(v: {
			payload: Record<string, any>;
			identityId: string;
			mailboxId: string;
			status: "scheduled";
			origin: "direct";
			messageId: string;
			scheduledAt: Date;
		}): Promise<{ id: string }>;
		newMessageId(from: string): string;
	},
	now: Date = new Date(),
): Promise<string> {
	const key = `${job.id}:${job.timestamp}`;
	const existing = await io.findByLegacyKey(key);
	if (existing) return existing.id;
	const created = await io.insertRow({
		payload: { ...job.data, __legacyJobKey: key },
		identityId: ident.identityId,
		mailboxId: String(job.data.mailboxId || job.data.sentMailboxId || ""),
		status: "scheduled",
		origin: "direct",
		messageId: io.newMessageId(ident.fromAddress),
		scheduledAt: now,
	});
	return created.id;
}
