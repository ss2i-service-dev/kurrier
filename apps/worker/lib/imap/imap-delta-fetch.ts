import {
	db,
	identities,
	mailboxes,
	mailboxSync,
	messages,
	mailboxThreads,
} from "@db";
import { and, desc, eq, sql } from "drizzle-orm";
import { parseAndStoreEmail } from "../message-payload-parser";
import { initSmtpClient } from "./imap-client";
import type { ImapFlow } from "imapflow";
import { syncMailbox } from "./imap-sync-mailbox";
import { upsertMailboxThreadItem } from "@common";
import { getRedis } from "../../lib/get-redis";

/**
 * Incremental sync for all mailboxes of an identity.
 * - Skips mailboxes that are backfilling / not idle
 * - Inserts new messages
 * - Detects cross-mailbox moves and updates:
 *     * messages.mailboxId + metaData.imap.mailboxPath for all msgs in the thread
 *     * threads.mailboxId
 *     * mailboxThreads (re-upsert from newest msg)
 *     * search index (refresh-thread)
 */
export const deltaFetch = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) => {
	const client = await initSmtpClient(identityId, imapInstances);
	if (!client?.authenticated || !client?.usable) return;

	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, identityId));
	const ownerId = identity?.ownerId;
	const workspaceId = identity?.workspaceId;
	if (!ownerId || !workspaceId) return;

	const mailboxRows = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.identityId, identityId));

	// Gmail's "All Mail" (\All) goes last, so that a new message is first filed in its real
	// folder (INBOX, Sent) and only recognized afterwards.
	const isAllMail = (r: (typeof mailboxRows)[number]) =>
		String((r.metaData as any)?.imap?.specialUse ?? "").toLowerCase() === "\\all";
	mailboxRows.sort((a, b) => Number(isAllMail(a)) - Number(isAllMail(b)));

	for (const row of mailboxRows) {
		// only when fully idle
		const [syncRow] = await db
			.select()
			.from(mailboxSync)
			.where(
				and(
					eq(mailboxSync.identityId, identityId),
					eq(mailboxSync.mailboxId, row.id),
				),
			);

		if (!syncRow) continue;
		// if (syncRow.phase !== "IDLE" || Number(syncRow.backfillCursorUid || 0) > 0)
		// 	continue;

		await syncMailbox({
			client,
			identityId,
			workspaceId,
			mailboxId: row.id,
			path: String((row?.metaData as any)?.imap?.path ?? row.name),
			window: 500,
			onMessage: async (msg, path: string) => {
				const messageId = msg.envelope?.messageId?.trim() || null;
				const uid = msg.uid;
				const raw = (await msg.source?.toString()) || "";

				const flags = msg.flags ?? new Set<string>();
				const isSeen = flags.has("\\Seen");
				const isFlagged = flags.has("\\Flagged");
				const isAnswered = flags.has("\\Answered");

				if (!messageId) {
					console.warn(
						`[deltaFetch] Missing Message-ID — path=${path} uid=${uid}`,
					);
					return await parseAndStoreEmail(raw, {
						ownerId,
						workspaceId,
						mailboxId: row.id,
						rawStorageKey: `eml/${ownerId}/${row.id}/${uid}.eml`,
						emlKey: String(msg.id),
						metaData: {
							imap: {
								uid,
								mailboxPath: path,
								flags: [...flags],
								internalDate: (msg as any).internalDate ?? null,
							},
						},
						seen: isSeen,
						flagged: isFlagged,
						answered: isAnswered,
					});
				}

				// This message is already in THIS folder in the database (move done by the app, cursor
				// lowered below a duplicate): nothing to do. Without this early exit, the row picked below
				// among all those sharing this Message-ID could be the Sent copy: "move detected", then the
				// Sent copy deleted.
				const [here] = await db
					.select({ id: messages.id })
					.from(messages)
					.where(
						and(
							eq(messages.ownerId, ownerId),
							eq(messages.messageId, messageId),
							eq(messages.mailboxId, row.id),
						),
					)
					.limit(1);
				if (here) return;

				const [existing] = await db
					.select({
						id: messages.id,
						mailboxId: messages.mailboxId,
						threadId: messages.threadId,
					})
					.from(messages)
					.where(
						and(
							eq(messages.ownerId, ownerId),
							eq(messages.messageId, messageId),
						),
					);

				if (existing) {
					// Gmail's "All Mail" (\All) also lists INBOX and Sent mail. Seeing a message known
					// elsewhere there is not a move: without this guard, every new message would leave the INBOX
					// for the archive.
					if (isAllMail(row)) return;
					if (existing.mailboxId !== row.id) {
						console.log(
							`[deltaFetch] Move detected for ${messageId}: ${existing.mailboxId} → ${row.id}`,
						);

						const all = await db
							.select({
								id: messages.id,
								mailboxId: messages.mailboxId,
								metaData: messages.metaData,
								messageId: messages.messageId,
							})
							.from(messages)
							.where(
								and(
									eq(messages.threadId, existing.threadId),
									eq(messages.mailboxId, existing.mailboxId),
								),
							);

						for (const m of all) {
							if (m.mailboxId === row.id) continue;

							const [dup] = await db
								.select({ id: messages.id })
								.from(messages)
								.where(
									and(
										eq(messages.ownerId, ownerId),
										eq(messages.messageId, m.messageId),
										eq(messages.mailboxId, row.id),
									),
								);

							// A copy of this message is already in this folder: leave it where it is. Deleting it
							// would often remove the Sent copy (same Message-ID as the INBOX or Archive one).
							if (dup?.id) continue;

							const updatedMeta = {
								...(m.metaData as any),
								imap: {
									...((m.metaData as any)?.imap || {}),
									mailboxPath: path,
								},
							};

							await db
								.update(messages)
								.set({ mailboxId: row.id, metaData: updatedMeta })
								.where(eq(messages.id, m.id))
								.catch((e) =>
									console.error("[deltaFetch] failed message move update", e),
								);
						}

						await db
							.delete(mailboxThreads)
							.where(eq(mailboxThreads.threadId, existing.threadId));

						const [newest] = await db
							.select({ id: messages.id })
							.from(messages)
							.where(eq(messages.threadId, existing.threadId))
							.orderBy(
								desc(sql`coalesce(${messages.date}, ${messages.createdAt})`),
							)
							.limit(1);

						if (newest?.id) {
							await upsertMailboxThreadItem(newest.id).catch((e) =>
								console.error("[deltaFetch] upsertMailboxThreadItem failed", e),
							);
						}

						try {
							const { searchIngestQueue } = await getRedis();
							await searchIngestQueue.add(
								"refresh-thread",
								{ threadId: existing.threadId },
								{
									jobId: `refresh-${existing.threadId}`,
									attempts: 3,
									backoff: { type: "exponential", delay: 1500 },
									removeOnComplete: true,
									removeOnFail: false,
								},
							);
						} catch (e) {
							console.warn("[deltaFetch] enqueue refresh-thread failed", e);
						}

						return;
					}

					return;
				}

				await parseAndStoreEmail(raw, {
					ownerId,
					workspaceId,
					mailboxId: row.id,
					rawStorageKey: `eml/${ownerId}/${row.id}/${uid}.eml`,
					emlKey: String(msg.id),
					metaData: {
						imap: {
							uid,
							mailboxPath: path,
							flags: [...flags],
							// Server-side receive date, used as the message date when the Date header is missing or
							// malformed (see message-payload-parser).
							internalDate: (msg as any).internalDate ?? null,
						},
					},
					seen: isSeen,
					flagged: isFlagged,
					answered: isAnswered,
				});

				return undefined as any;
			},
		});
	}
};
