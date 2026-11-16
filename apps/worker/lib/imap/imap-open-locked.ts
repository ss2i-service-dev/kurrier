import type { ImapFlow } from "imapflow";

// ss2i (16/11/2026) : les traitements d'une identite partagent une connexion IMAP de commandes
// (imapInstances). La synchro courante (syncMailbox) verrouille le dossier qu'elle lit ; un
// mailboxOpen fait ailleurs sans verrou (decouverte des dossiers, creation d'un dossier)
// rebasculait la selection en pleine passe. Le 30/10 et le 04/11, le FETCH des UID de Drafts est
// ainsi parti sur INBOX : les messages INBOX portant ces UID, deja connus en base, ont ete pris
// pour des deplacements vers Drafts, et chacun a emporte tout son fil (« brouillons » de jb et
// hugo). Toute ouverture de dossier sur une connexion partagee passe donc par le verrou.

/** Ouvre `path` en lecture seule sous le verrou de la connexion et rend son etat. */
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

/** Vrai quand le dossier selectionne sur la connexion est bien `path`. */
export function selectedIs(client: ImapFlow, path: string): boolean {
	const box = client.mailbox as any;
	return !!box && box.path === path;
}
