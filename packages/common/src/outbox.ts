// ss2i : Boite d'envoi (OI 10519). Mise en file et annulation d'un envoi, arbitrees par la ligne
// ledger draft_messages (une ligne par envoi). Pur : la base, Redis et l'IMAP sont passes en
// parametre (cf. apps/web/test/outbox-cancel.ts), utilise par l'interface web, le MCP et le worker.
import { scheduledJobOf } from "./schedule-send";
import { sendStateOf, type LedgerStateRow, type SendState } from "./outbox-state";

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
	// Ecarte les echecs precedents du meme brouillon (un nouvel envoi les remplace).
	supersede?: (imapDraftId: string) => Promise<unknown>;
};

export type EnqueueResult =
	| { ok: true; rowId: string; messageId: string; scheduledAt: Date }
	| { ok: false; error: string };

// Ligne scheduled d'abord, puis le job de meme id. Le job n'est jamais rejoue par BullMQ (un
// renvoi apres un 250 perdu double l'envoi) : pas d'attempts. Sans job, la ligne est retiree.
export async function enqueueSend(input: EnqueueInput, io: EnqueueIo, now: Date = new Date()): Promise<EnqueueResult> {
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
	const job = scheduledJobOf(
		{ id: row.id, identityId: input.identityId, scheduledAt: row.scheduledAt ?? input.sendAt, payload: input.payload },
		now.getTime(),
	);
	try {
		await io.addJob(job.name, job.data, job.opts);
	} catch (err: any) {
		await io.deleteRow(row.id).catch((e) => console.error("[outbox] ligne sans job non retiree", row.id, e));
		return { ok: false, error: String(err?.message ?? err) };
	}
	const draftId = input.payload?.draftMessageId;
	if (draftId && io.supersede) {
		await io.supersede(String(draftId)).catch((e) => console.error("[outbox] supersede", draftId, e));
	}
	return { ok: true, rowId: row.id, messageId, scheduledAt: new Date(row.scheduledAt ?? input.sendAt) };
}

export type CancelIo = {
	// UPDATE draft_messages SET status = 'canceled' WHERE id = ? AND status = 'scheduled' RETURNING
	casCancel: () => Promise<unknown | null>;
	readRow: () => Promise<LedgerStateRow | null>;
	removeJob: () => Promise<unknown>;
	restore: () => Promise<unknown>;
};

export type CancelResult = { cancelled: boolean; state: SendState | null };

// Annuler : la CAS scheduled -> canceled passe avant tout. Gagnee (ou deja annulee : on
// deverrouille a nouveau, idempotent), le job est retire puis le brouillon restaure ; leurs echecs
// ne defont pas l'annulation (le worker ne reclame qu'une ligne scheduled). Perdue, rien n'est
// touche et l'etat reel est rendu.
export async function cancelSend(io: CancelIo): Promise<CancelResult> {
	const won = await io.casCancel();
	if (!won) {
		const row = await io.readRow();
		if (!row || row.status !== "canceled") return { cancelled: false, state: row ? sendStateOf(row) : null };
	}
	await io.removeJob().catch((e) => console.error("[outbox] retrait du job", e));
	await io.restore().catch((e) => console.error("[outbox] restauration du brouillon", e));
	return { cancelled: true, state: "canceled" };
}
