// ss2i : dossiers sans compteur de non lus. Ce qu'on a envoye, ce qui attend l'envoi, ses
// propres brouillons, l'Archive et la Corbeille n'appellent aucune attention (Samuel le 10/11 :
// « ça n'a aucun putain de sens d'afficher le nombre de mails envoyés ou en attente d'envoi »).
// Regle unique pour le calcul serveur et les trois barres laterales.
export const NO_UNREAD_COUNT_KINDS = ["sent", "outbox", "drafts", "archive", "trash"] as const;

export function showsUnreadCount(kind: string | null | undefined): boolean {
	return !(NO_UNREAD_COUNT_KINDS as readonly string[]).includes(String(kind ?? ""));
}

// ss2i : compteur des barres laterales nourries par fetchDraftCounts (interface classique et
// nouvelle interface). Drafts y affiche son nombre de brouillons, envois en attente exclus, et
// non des non lus (Samuel le 12/11 : « ce qui serait intéressant, c'est qu'on ait le nombre de
// drafts en attente d'envoi à côté de drafts »).
export function showsSidebarCount(kind: string | null | undefined): boolean {
	return kind === "drafts" || showsUnreadCount(kind);
}
