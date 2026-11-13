// ss2i : Boite d'envoi (OI 10519). Mise en file et annulation d'un envoi, arbitrees par la ligne
// ledger draft_messages (une ligne par envoi). Pur : la base, Redis et l'IMAP sont passes en
// parametre (cf. apps/web/test/outbox-cancel.ts), utilise par l'interface web, le MCP et le worker.
import { scheduledJobOf } from "./schedule-send";
import { sendStateOf, type LedgerStateRow, type SendState } from "./outbox-state";
import { DRAFT_MAYBE_SENT_ERROR, settleActionOf, type SettleAction } from "./draft-send";

// Origine d'un envoi : delai d'annulation, envoi programme, envoi immediat (MCP, API, lien de
// desabonnement, invitation).
export type SendOrigin = "undo" | "scheduled" | "direct";

// Message-ID fixe par courrier avant le SMTP, au format de nodemailer (<uuid@domaine de
// l'expediteur>, « localhost » sans domaine) : il correle la ligne, le message accepte et la
// copie Envoyes, et rend la reprise apres crash idempotente.
export function messageIdFor(fromAddress: string | null | undefined, uuid: string): string {
	const raw = String(fromAddress ?? "");
	const bracketed = raw.match(/<([^>]*)>/)?.[1] ?? raw;
	const domain = bracketed.split("@")[1]?.trim().toLowerCase().replace(/[>\s].*$/, "");
	return `<${uuid}@${domain || "localhost"}>`;
}

export type EnqueueInput = {
	payload: Record<string, any>;
	identityId: string;
	mailboxId: string;
	origin: SendOrigin;
	sendAt: Date;
	fromAddress: string | null | undefined;
};

export type EnqueueRowValues = {
	payload: Record<string, any>;
	identityId: string;
	mailboxId: string;
	status: "scheduled";
	origin: SendOrigin;
	messageId: string;
	scheduledAt: Date;
};

export type EnqueueIo = {
	uuid?: () => string;
	insertRow: (v: EnqueueRowValues) => Promise<{ id: string; scheduledAt: Date | string | null }>;
	addJob: (name: string, data: Record<string, any>, opts: Record<string, any>) => Promise<unknown>;
	deleteRow: (id: string) => Promise<unknown>;
	// Ligne sans job qui n'a pas pu etre retiree : passee en canceled (UPDATE ... WHERE status =
	// 'scheduled'), sinon elle resterait programmee pour rien.
	cancelRow?: (id: string) => Promise<unknown>;
	// Marque d'envoi du brouillon (pendingSend, jobId = ligne), posee AVANT le job : le worker ne
	// la retire qu'apres (un envoi immediat en echec ne la voit pas reposee). Faux = pas d'envoi.
	mark?: (row: { id: string; scheduledAt: Date }) => Promise<boolean>;
	// Marque retiree quand le job n'a pas pu etre ajoute.
	unmark?: () => Promise<unknown>;
	// Ecarte les echecs precedents du meme brouillon (un nouvel envoi les remplace), jamais un
	// envoi interrompu.
	supersede?: (imapDraftId: string) => Promise<unknown>;
	// Le brouillon a-t-il un envoi interrompu non ecarte (failed, acceptance_unknown, jamais accepte) ?
	interrupted?: (imapDraftId: string) => Promise<boolean>;
};

export type EnqueueResult =
	| { ok: true; rowId: string; messageId: string; scheduledAt: Date }
	| { ok: false; error: string; maybeSent?: boolean };

// Ligne scheduled d'abord, puis la marque du brouillon, puis le job de meme id. Le job n'est jamais rejoue par BullMQ (un
// renvoi apres un 250 perdu double l'envoi) : pas d'attempts. Sans job, la ligne est retiree.
// Un brouillon dont un envoi precedent est interrompu (peut-etre parti) ne repart pas : refus
// explicite avant toute ligne, a regler dans la Boite d'envoi.
export async function enqueueSend(input: EnqueueInput, io: EnqueueIo, now: Date = new Date()): Promise<EnqueueResult> {
	const draftId = input.payload?.draftMessageId;
	if (draftId && io.interrupted && (await io.interrupted(String(draftId)))) {
		return { ok: false, error: DRAFT_MAYBE_SENT_ERROR, maybeSent: true };
	}
	const uuid = io.uuid ?? (() => globalThis.crypto.randomUUID());
	const messageId = messageIdFor(input.fromAddress, uuid());
	const row = await io.insertRow({
		payload: input.payload,
		identityId: input.identityId,
		mailboxId: input.mailboxId,
		status: "scheduled",
		origin: input.origin,
		messageId,
		scheduledAt: input.sendAt,
	});
	const scheduledAt = new Date(row.scheduledAt ?? input.sendAt);
	const dropRow = () =>
		io.deleteRow(row.id).catch(async (e) => {
			console.error("[outbox] ligne sans job non retiree", row.id, e);
			if (io.cancelRow) await io.cancelRow(row.id).catch((e2) => console.error("[outbox] ligne sans job non annulee", row.id, e2));
		});
	if (io.mark && !(await io.mark({ id: row.id, scheduledAt }).catch(() => false))) {
		await dropRow();
		return { ok: false, error: "draft send mark could not be set" };
	}
	const job = scheduledJobOf(
		{ id: row.id, identityId: input.identityId, scheduledAt, payload: input.payload },
		now.getTime(),
	);
	try {
		await io.addJob(job.name, job.data, job.opts);
	} catch (err: any) {
		await dropRow();
		if (io.unmark) await io.unmark().catch((e) => console.error("[outbox] marque non retiree", row.id, e));
		return { ok: false, error: String(err?.message ?? err) };
	}
	if (draftId && io.supersede) {
		await io.supersede(String(draftId)).catch((e) => console.error("[outbox] supersede", draftId, e));
	}
	return { ok: true, rowId: row.id, messageId, scheduledAt };
}

// « Envoyer maintenant » : la ligne ledger decide (`rowStatus` null = pas de ligne visible, envoi
// d'avant le ledger). Job en attente -> promu ; job absent ou fini (failed, completed : BullMQ
// garde l'id, un ajout de meme id serait ignore, il est retire avant) alors que la ligne est encore
// scheduled -> rajoute depuis la ligne ; ligne sortie de scheduled ou job deja en cours -> rien.
export type SendNowPlan = "promote" | "readd" | "none";
export function sendNowPlanOf(jobState: string | null, rowStatus: string | null): SendNowPlan {
	if (rowStatus !== null && rowStatus !== "scheduled") return "none";
	if (jobState === "delayed") return "promote";
	const gone = jobState === null || jobState === "unknown" || jobState === "failed" || jobState === "completed";
	return rowStatus === "scheduled" && gone ? "readd" : "none";
}

export type CancelIo = {
	// UPDATE draft_messages SET status = 'canceled' WHERE id = ? AND status = 'scheduled' RETURNING
	casCancel: () => Promise<unknown | null>;
	readRow: () => Promise<LedgerStateRow | null>;
	removeJob: () => Promise<unknown>;
	// Contenu de la ligne remis dans le brouillon, marque d'envoi retiree (CAS gagnee seulement).
	restore: () => Promise<unknown>;
	// Ligne deja annulee : retire seulement la marque d'envoi du brouillon si elle designe encore
	// cette ligne (une restauration precedente en echec l'a laissee), sans toucher au contenu.
	unlock?: () => Promise<unknown>;
	// Ligne terminee alors que le brouillon porte encore sa marque (settleActionOf) : brouillon
	// supprime si l'envoi est parti avec sa copie Envoyes, marque seule retiree sinon ; dans les
	// deux cas seulement si la marque designe encore cette ligne.
	settle?: (action: SettleAction) => Promise<unknown>;
};

export type CancelResult = { cancelled: boolean; state: SendState | null };

// Annuler : la CAS scheduled -> canceled passe avant tout. Gagnee, le job est retire puis le
// brouillon restaure ; leurs echecs ne defont pas l'annulation (le worker ne reclame qu'une ligne
// scheduled). Deja annulee (second clic, onglet perime) : job retire et marque retiree, jamais de
// restauration (le contenu de la ligne ecraserait un brouillon modifie depuis). Perdue, rien
// n'est restaure et l'etat reel est rendu ; une ligne terminee remet le brouillon d'aplomb.
export async function cancelSend(io: CancelIo): Promise<CancelResult> {
	const won = await io.casCancel();
	if (!won) {
		const row = await io.readRow();
		if (!row || row.status !== "canceled") {
			const action = row ? settleActionOf(row) : null;
			if (action && io.settle) await io.settle(action).catch((e) => console.error("[outbox] menage du brouillon", e));
			return { cancelled: false, state: row ? sendStateOf(row) : null };
		}
	}
	await io.removeJob().catch((e) => console.error("[outbox] retrait du job", e));
	if (won) await io.restore().catch((e) => console.error("[outbox] restauration du brouillon", e));
	else if (io.unlock) await io.unlock().catch((e) => console.error("[outbox] deverrouillage du brouillon", e));
	return { cancelled: true, state: "canceled" };
}
