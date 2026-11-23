import type { ImapFlow } from "imapflow";

// The processing of an identity shares one IMAP command connection (imapInstances). The current
// sync (syncMailbox) locks the folder it reads; a mailboxOpen done elsewhere without the lock
// (folder discovery, folder creation) switched the selection in the middle of a pass. The FETCH
// of the Drafts UIDs then went to the Inbox: the Inbox messages carrying those UIDs, already
// known in the database, were taken for moves to Drafts, and each carried its whole thread away.
// Every folder opening on a shared connection therefore goes through the lock.

/** Opens `path` read-only under the connection lock and returns its state. */
export async function openMailboxLocked(client: ImapFlow, path: string) {
	const lock = await client.getMailboxLock(path, { readOnly: true });
	try {
		const box = client.mailbox as any;
		return {
			path: box?.path as string,
			uidValidity: box?.uidValidity,
			uidNext: box?.uidNext as number | undefined,
		};
	} finally {
		lock.release();
	}
}

/** True when the folder selected on the connection is `path`. */
export function selectedIs(client: ImapFlow, path: string): boolean {
	const box = client.mailbox as any;
	return !!box && box.path === path;
}
