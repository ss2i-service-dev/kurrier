// Outbox. draft_messages ledger in Drizzle for the send pipeline (lib/send/pipeline.ts): each
// transition is a single UPDATE ... WHERE <expected state> RETURNING, a lost transition returns
// null.
import { db, draftMessages, messages } from "@db";
import { and, eq, gt, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
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
					// Existing readers (list of scheduled sends): the error stays here too.
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
							// Interrupted by the sweep during an SMTP exchange that ended up succeeding.
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

	// message_id set: only ledger sends (a sending row from before the ledger is set aside by
	// community_008, never woken up as "interrupted" at boot).
	staleSending: async (before) =>
		db
			.select(ledgerCols)
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "sending"),
					isNull(draftMessages.acceptedAt),
					isNotNull(draftMessages.messageId),
					lt(draftMessages.updatedAt, before),
				),
			),

	setMessageId: async (id, messageId) =>
		one(
			await db
				.update(draftMessages)
				.set({ messageId, updatedAt: new Date() })
				.where(and(eq(draftMessages.id, id), eq(draftMessages.status, "sending"), isNull(draftMessages.messageId)))
				.returning(ledgerCols),
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

	// Send mark of a draft -> its ledger row: the draft is found by its primary key
	// (payload.draftMessageId), only recent rows are scanned.
	orphanMarks: async (before, since) =>
		db
			.select({
				rowId: draftMessages.id,
				status: draftMessages.status,
				acceptedAt: draftMessages.acceptedAt,
				sentRowId: draftMessages.sentRowId,
				dismissedAt: draftMessages.dismissedAt,
				acceptanceUnknown: draftMessages.acceptanceUnknown,
				lastError: draftMessages.lastError,
				identityId: draftMessages.identityId,
				draftId: messages.id,
				ownerId: messages.ownerId,
			})
			.from(draftMessages)
			.innerJoin(
				messages,
				and(
					sql`${messages.id} = case when ${draftMessages.payload}->>'draftMessageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${draftMessages.payload}->>'draftMessageId')::uuid end`,
					sql`${messages.metaData}->'draft'->'pendingSend'->>'jobId' = ${draftMessages.id}::text`,
				),
			)
			.where(
				and(
					notInArray(draftMessages.status, ["scheduled", "sending"]),
					lt(draftMessages.updatedAt, before),
					gt(draftMessages.updatedAt, since),
				),
			),
};

// Row locked for finalizing (SELECT ... FOR UPDATE in the transaction of the Sent copy): two
// concurrent finalizations run one after the other, the second one sees sent_row_id.
export async function lockLedgerRow(tx: Pick<typeof db, "select">, id: string): Promise<LedgerRow | null> {
	const [row] = await tx.select(ledgerCols).from(draftMessages).where(eq(draftMessages.id, id)).for("update").limit(1);
	return (row as LedgerRow) ?? null;
}

// Row of a legacy "send-and-reconcile" job, found by its job.id:timestamp key.
export async function findByLegacyKey(key: string) {
	const [row] = await db
		.select({
			id: draftMessages.id,
			status: draftMessages.status,
			acceptedAt: draftMessages.acceptedAt,
			acceptanceUnknown: draftMessages.acceptanceUnknown,
			lastError: draftMessages.lastError,
		})
		.from(draftMessages)
		.where(sql`${draftMessages.payload}->>'__legacyJobKey' = ${key}`)
		.limit(1);
	return row ?? null;
}
