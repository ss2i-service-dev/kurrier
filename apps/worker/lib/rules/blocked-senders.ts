import { db, blockedSenders } from "@db";
import { eq } from "drizzle-orm";
import { isBlockedSender, type BlockEntry } from "@common";
import { markAsRead } from "./rule-items/mark-read";
import { moveToTrash } from "./rule-items/move-to-trash";

// Blocked senders (blocked_senders table, per user). On receipt of a message in an
// identity's Inbox, a blocked sender has the message sent to the identity's trash (real
// IMAP move, same path as the Delete action, but at message granularity), marked read on
// the way so that no unread counter is left behind. Mail already present is handled on the
// user's request by the web app (mail:move batches), not here.
export async function loadBlockEntries(ownerId: string): Promise<BlockEntry[]> {
	const rows = await db
		.select({ kind: blockedSenders.kind, value: blockedSenders.value })
		.from(blockedSenders)
		.where(eq(blockedSenders.ownerId, ownerId));
	return rows as BlockEntry[];
}

export async function trashIfBlocked(opts: {
	message: { id: string; from: any };
	mailbox: { id: string; ownerId: string; kind: string };
	threadId: string;
	moveImap: boolean;
}): Promise<boolean> {
	if (opts.mailbox.kind !== "inbox") return false;
	const from = (opts.message.from as any)?.value?.[0]?.address as string | undefined;
	if (!from) return false;
	const entries = await loadBlockEntries(opts.mailbox.ownerId);
	if (!entries.length || !isBlockedSender(from, entries)) return false;

	console.info(`[COMMON] Blocked sender ${from}: message ${opts.message.id} -> Trash`);
	// Message granularity: the rest of a mixed thread (other senders) does not move.
	await markAsRead(opts.threadId, opts.mailbox.id, opts.moveImap, [opts.message.id]);
	await moveToTrash(opts.threadId, opts.mailbox.id, opts.moveImap, opts.message.id, true);
	return true;
}
