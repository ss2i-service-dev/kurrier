// ss2i : dossiers sans compteur de non lus. Ce qu'on a envoye, ce qui attend l'envoi, ses
// propres brouillons, l'Archive et la Corbeille n'appellent aucune attention (Samuel le 10/11 :
// « ça n'a aucun putain de sens d'afficher le nombre de mails envoyés ou en attente d'envoi »).
// Regle unique pour le calcul serveur et les trois barres laterales.
export const NO_UNREAD_COUNT_KINDS = ["sent", "outbox", "drafts", "archive", "trash"] as const;

export function showsUnreadCount(kind: string | null | undefined): boolean {
	return !(NO_UNREAD_COUNT_KINDS as readonly string[]).includes(String(kind ?? ""));
}
