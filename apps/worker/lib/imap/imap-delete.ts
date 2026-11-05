import { ImapFlow } from "imapflow";
import { initSmtpClient } from "./imap-client";
import { resolveUids, type UidRow } from "./imap-resolve-uids";

import { db, messages, mailboxThreads, mailboxes, threads } from "@db";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

// Permanent deletion, so the UID is verified by Message-ID before acting (see
// imap-resolve-uids.ts): a stale UID would delete another message in the folder.
async function deleteUids(
	client: ImapFlow,
	mailboxPath: string,
	rows: UidRow[],
) {
	if (!rows.length) return;
	const lock = await client.getMailboxLock(mailboxPath);
	try {
		const uids = [...(await resolveUids(client, rows)).keys()];
		if (uids.length) await client.messageDelete(uids, { uid: true });
	} finally {
		lock.release();
	}
}

function collectUidsByMailboxPath(
	rows: Array<{ id: string; meta: unknown; messageId: string | null }>,
): Map<string, UidRow[]> {
	const byPath = new Map<string, UidRow[]>();
	for (const r of rows) {
		const imap = (r.meta as any)?.imap;
		const path = imap?.mailboxPath as string | undefined;
		const uid = Number(imap?.uid);
		if (!path || !uid) continue;
		if (!byPath.has(path)) byPath.set(path, []);
		byPath.get(path)!.push({ id: r.id, uid, messageId: r.messageId });
	}
	return byPath;
}

export async function deleteMail(
	data: {
		mailboxId: string;
		threadId?: string | string[];
		emptyAll?: boolean;
		imapDelete: boolean;
	},
	imapInstances: Map<string, ImapFlow>,
) {
	const { mailboxId, emptyAll, imapDelete } = data;
	if (!mailboxId) return;

	const [box] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId));
	if (!box) return;

	const mailboxPath: string =
		(box.metaData as any)?.imap?.path || box.name || "";

	let client;
	if (imapDelete) {
		client = await initSmtpClient(box.identityId, imapInstances);
		if (!client?.authenticated || !client.usable) return;
	}

	if (emptyAll) {
		if (imapDelete && client) {
			try {
				const lock = await client.getMailboxLock(String(mailboxPath));
				try {
					const allUids: number[] =
						(await client.search({ all: true }, { uid: true })) || [];
					if (allUids.length) {
						await client.messageDelete(allUids, { uid: true });
					}
				} finally {
					lock.release();
				}
			} catch (err) {
				console.error("[deleteMail] emptyAll IMAP delete failed:", err);
			}
		}

		const rows = await db
			.select({ id: messages.id, threadId: messages.threadId })
			.from(messages)
			.where(eq(messages.mailboxId, mailboxId));

		const allMessageIds = rows.map((r) => r.id);
		const affectedThreadIds = Array.from(new Set(rows.map((r) => r.threadId)));

		await db.transaction(async (tx) => {
			if (allMessageIds.length) {
				await tx.delete(messages).where(inArray(messages.id, allMessageIds));
			}
			if (affectedThreadIds.length) {
				await tx
					.delete(mailboxThreads)
					.where(
						and(
							eq(mailboxThreads.mailboxId, mailboxId),
							inArray(mailboxThreads.threadId, affectedThreadIds),
						),
					);

				await tx
					.delete(threads)
					.where(
						and(
							inArray(threads.id, affectedThreadIds),
							notExists(
								tx
									.select({ one: sql`1` })
									.from(messages)
									.where(eq(messages.threadId, threads.id)),
							),
						),
					);
			}
		});

		return;
	}

	const threadIds = Array.isArray(data.threadId)
		? data.threadId.filter(Boolean)
		: data.threadId
			? [data.threadId]
			: [];

	if (!threadIds.length) return;

	const msgRows = await db
		.select({
			id: messages.id,
			threadId: messages.threadId,
			meta: messages.metaData,
			messageId: messages.messageId,
		})
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				inArray(messages.threadId, threadIds),
			),
		);

	if (imapDelete && client) {
		try {
			const byPath = collectUidsByMailboxPath(msgRows);
			for (const [path, rows] of byPath) {
				if (!rows.length) continue;
				await deleteUids(client, path, rows);
			}
		} catch (err) {
			console.error("[deleteMail] IMAP per-thread delete failed:", err);
		}
	}

	const allMessageIds = msgRows.map((r) => r.id);

	await db.transaction(async (tx) => {
		if (allMessageIds.length) {
			await tx.delete(messages).where(inArray(messages.id, allMessageIds));
		}

		await tx
			.delete(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.mailboxId, mailboxId),
					inArray(mailboxThreads.threadId, threadIds),
				),
			);

		await tx
			.delete(threads)
			.where(
				and(
					inArray(threads.id, threadIds),
					notExists(
						tx
							.select({ one: sql`1` })
							.from(messages)
							.where(eq(messages.threadId, threads.id)),
					),
				),
			);
	});
}
