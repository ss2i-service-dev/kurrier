import { db, blockedSenders } from "@db";
import { eq } from "drizzle-orm";
import { isBlockedSender, type BlockEntry } from "@common";
import { markAsRead } from "./rule-items/mark-read";
import { moveToTrash } from "./rule-items/move-to-trash";

// ss2i : expediteurs bloques (table blocked_senders, par utilisateur). A la reception d'un
// message dans l'Inbox d'une identite, l'expediteur bloque envoie le message a la corbeille de
// l'identite (deplacement IMAP reel, meme chemin que l'action Delete, mais au grain du message), marque lu au passage
// pour ne laisser aucun compteur non lu. Les mails deja presents sont traites a la demande
// de l'utilisateur par le web (lots mail:move), pas ici.
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
	// Au grain du message : le reste d'un fil mixte (autres expediteurs) ne bouge pas.
	await markAsRead(opts.threadId, opts.mailbox.id, opts.moveImap, [opts.message.id]);
	await moveToTrash(opts.threadId, opts.mailbox.id, opts.moveImap, opts.message.id, true);
	return true;
}
