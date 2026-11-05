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

	// ss2i : « Tous les messages » (\All, Gmail) passe en dernier, pour qu'un nouveau message
	// soit d'abord range dans son vrai dossier (INBOX, Envoyes) et seulement reconnu ensuite.
	const isAllMail = (r: (typeof mailboxRows)[number]) =>
		String((r.metaData as any)?.imap?.specialUse ?? "").toLowerCase() === "\\all";
	mailboxRows.sort((a, b) => Number(isAllMail(a)) - Number(isAllMail(b)));
	// ss2i : dossiers des Envoyes (voir isSentCopy plus bas).
	const sentIds = new Set(mailboxRows.filter((r) => r.kind === "sent").map((r) => r.id));

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

				// ss2i (OI 10286) : ce message est deja dans CE dossier en base (deplacement fait par
				// courrier, curseur redescendu sous un doublon) : rien a faire. Sans cette sortie, la
				// ligne prise plus bas parmi toutes celles de ce Message-ID pouvait etre la copie des
				// Envoyes : « deplacement detecte », puis copie des Envoyes supprimee.
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

				// ss2i : un message envoye qui revient aussi dans un autre dossier (ma propre adresse,
				// ou une liste qui me contient, en destinataire : dev@ en copie le 05/11) est une
				// COPIE, pas un deplacement : il est dans les Envoyes ET dans l'INBOX, comme dans
				// Outlook. Le prendre pour un deplacement faisait faire au fil des allers-retours
				// INBOX <-> Envoyes, et le dernier emportait dans les Envoyes les reponses recues
				// entre-temps (reponse d'OPTI MARCHE invisible dans la boite de reception).
				let isSentCopy = false;
				if (existing && existing.mailboxId !== row.id && !isAllMail(row)) {
					if (sentIds.has(row.id)) isSentCopy = true;
					else {
						const copies = await db
							.select({ mailboxId: messages.mailboxId })
							.from(messages)
							.where(and(eq(messages.ownerId, ownerId), eq(messages.messageId, messageId)));
						isSentCopy = copies.some((c) => sentIds.has(c.mailboxId));
					}
				}

				if (existing && !isSentCopy) {
					// ss2i : « Tous les messages » (\All, Gmail) liste aussi le courrier de l'INBOX
					// et des Envoyes. Y voir un message connu ailleurs n'est pas un deplacement :
					// sans cette garde, chaque nouveau message quittait l'INBOX pour l'archive.
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

							// ss2i (OI 10286) : une copie de ce message est deja dans ce dossier : on laisse
							// celle-ci ou elle est. L'amont la supprimait, et c'etait souvent la copie des
							// Envoyes (meme Message-ID que celle de l'INBOX ou de l'Archive).
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
							// ss2i : date de reception cote serveur, utilisee comme date du message
							// quand l'en-tete Date est absent ou malforme (cf. message-payload-parser).
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
