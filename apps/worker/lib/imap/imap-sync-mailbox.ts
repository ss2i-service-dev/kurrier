import { FetchMessageObject, ImapFlow } from "imapflow";
import { db, mailboxSync } from "@db";
import { and, eq } from "drizzle-orm";
import { selectedIs } from "./imap-open-locked";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function syncMailbox(opts: {
	client: ImapFlow;
	identityId: string;
	workspaceId: string
	mailboxId: string;
	path: string;
	window?: number;
	politeWaitMs?: number;
	onMessage: (
		msg: FetchMessageObject,
		path: string,
		identityId: string,
		workspaceId: string,
		mailboxId: string,
	) => Promise<void>;
}) {
	const {
		client,
		identityId,
		workspaceId,
		mailboxId,
		path,
		window = 500,
		politeWaitMs = 20,
		onMessage,
	} = opts;

	const lock = await client.getMailboxLock(path);
	try {
		const [sync] = await db
			.select()
			.from(mailboxSync)
			.where(
				and(
					eq(mailboxSync.identityId, identityId),
					eq(mailboxSync.mailboxId, mailboxId),
				),
			);
		if (!sync)
			throw new Error(`mailbox_sync row missing for mailboxId=${mailboxId}`);

		let lastSeen = Number(sync.lastSeenUid || 0);

		const box = await client.mailboxOpen(path, { readOnly: true });
		// The connection is shared; if another process switched folder without the lock, the FETCH
		// below would go to that folder and its messages would be filed here (Inbox taken for
		// Drafts). We stop, without advancing the cursor.
		const wrongFolder = () => {
			if (selectedIs(client, path)) return false;
			console.error("[imap:sync] unexpected selected folder, pass abandoned", {
				identityId,
				expected: path,
				selected: (client.mailbox as any)?.path ?? null,
			});
			return true;
		};
		if (wrongFolder()) return;
		const currentTop = Math.max(0, (box.uidNext ?? 1) - 1);
		if (currentTop <= lastSeen) return; // nothing new

		let start = lastSeen + 1;
		while (start <= currentTop) {
			const end = Math.min(currentTop, start + window - 1);
			const range = `${start}:${end}`;

			let maxUid = lastSeen;
			let aborted = false;

			if (wrongFolder()) return;
			for await (const msg of client.fetch(
				{ uid: range },
				{
					uid: true,
					envelope: true,
					flags: true,
					internalDate: true,
					size: true,
					source: true,
				},
			)) {
				// Selection changed during the FETCH: nothing in this batch can be trusted.
				if (aborted || wrongFolder()) {
					aborted = true;
					continue;
				}
				// A message the database refuses used to fail the whole pass, on every pass, and the
				// following folders were never synced again.
				try {
					await onMessage(msg, path, identityId, workspaceId, mailboxId);
				} catch (err: any) {
					console.error("[imap:sync] message not stored, skipped", {
						identityId,
						path,
						uid: msg.uid,
						error: err?.cause?.message ?? err?.message ?? String(err),
					});
				}
				if (msg.uid && msg.uid > maxUid) maxUid = msg.uid;
			}

			if (aborted) return;
			if (maxUid > lastSeen) {
				lastSeen = maxUid;
				await db
					.update(mailboxSync)
					.set({ lastSeenUid: lastSeen, updatedAt: new Date() })
					.where(eq(mailboxSync.id, sync.id));
			}

			start = end + 1;
			if (politeWaitMs) await sleep(politeWaitMs);
		}

		await db
			.update(mailboxSync)
			.set({ phase: "IDLE", syncedAt: new Date(), updatedAt: new Date() })
			.where(eq(mailboxSync.id, sync.id));
	} finally {
		lock.release();
	}
}
