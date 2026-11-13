// ss2i : Boite d'envoi (OI 10519). Ledger draft_messages en Drizzle pour le pipeline d'envoi
// (lib/send/pipeline.ts) : chaque transition est un seul UPDATE ... WHERE <etat attendu>
// RETURNING, une transition perdue rend null.
import { db, draftMessages } from "@db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { LedgerRow, LedgerStore } from "./pipeline";

export const ledgerCols = {
	id: draftMessages.id,
	status: draftMessages.status,
	payload: draftMessages.payload,
	identityId: draftMessages.identityId,
	messageId: draftMessages.messageId,
	acceptedAt: draftMessages.acceptedAt,
	acceptanceUnknown: draftMessages.acceptanceUnknown,
	deliveryState: draftMessages.deliveryState,
	rendered: draftMessages.rendered,
	sentRowId: draftMessages.sentRowId,
	updatedAt: draftMessages.updatedAt,
};

const one = (rows: LedgerRow[]) => rows[0] ?? null;

export const ledgerStore: LedgerStore = {
	get: async (id) => one(await db.select(ledgerCols).from(draftMessages).where(eq(draftMessages.id, id)).limit(1)),

	claim: async (id) =>
		one(
			await db
				.update(draftMessages)
				.set({ status: "sending", updatedAt: new Date() })
				.where(and(eq(draftMessages.id, id), eq(draftMessages.status, "scheduled")))
				.returning(ledgerCols),
		),

	fail: async (id, { error, ambiguous }) =>
		one(
			await db
				.update(draftMessages)
				.set({
					status: "failed",
					lastError: error,
					acceptanceUnknown: ambiguous,
					// Lecteurs existants (liste des envois programmes, MCP) : l'erreur reste aussi ici.
					payload: sql`jsonb_set(${draftMessages.payload}, '{__error}', to_jsonb(${error}::text), true)`,
					updatedAt: new Date(),
				})
				.where(and(eq(draftMessages.id, id), eq(draftMessages.status, "sending")))
				.returning(ledgerCols),
		),

	accept: async (id, { messageId, smtpResponse, rendered }) =>
		one(
			await db
				.update(draftMessages)
				.set({
					status: "sent",
					acceptedAt: new Date(),
					acceptanceUnknown: false,
					messageId,
					smtpResponse,
					rendered,
					lastError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(draftMessages.id, id),
						or(
							eq(draftMessages.status, "sending"),
							// Interrompu par le balayage pendant un SMTP qui a fini par aboutir.
							and(
								eq(draftMessages.status, "failed"),
								eq(draftMessages.acceptanceUnknown, true),
								isNull(draftMessages.acceptedAt),
							),
						),
					),
				)
				.returning(ledgerCols),
		),

	staleSending: async (before) =>
		db
			.select(ledgerCols)
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "sending"),
					isNull(draftMessages.acceptedAt),
					lt(draftMessages.updatedAt, before),
				),
			),

	unfinalized: async (before) =>
		db
			.select(ledgerCols)
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "sent"),
					lt(draftMessages.acceptedAt, before),
					eq(draftMessages.deliveryState, "none"),
					isNull(draftMessages.sentRowId),
					sql`${draftMessages.rendered} IS NOT NULL`,
				),
			),
};

// Ligne verrouillee pour la finalisation (SELECT ... FOR UPDATE dans la transaction de la copie
// Envoyes) : deux finalisations concurrentes passent l'une apres l'autre, la seconde voit sent_row_id.
export async function lockLedgerRow(tx: Pick<typeof db, "select">, id: string): Promise<LedgerRow | null> {
	const [row] = await tx.select(ledgerCols).from(draftMessages).where(eq(draftMessages.id, id)).for("update").limit(1);
	return (row as LedgerRow) ?? null;
}

// Ligne d'un job herite « send-and-reconcile », retrouvee par sa cle job.id:timestamp.
export async function findByLegacyKey(key: string) {
	const [row] = await db
		.select({ id: draftMessages.id })
		.from(draftMessages)
		.where(sql`${draftMessages.payload}->>'__legacyJobKey' = ${key}`)
		.limit(1);
	return row ?? null;
}
