// ss2i : la colonne « De » de la liste des mails montre l'auteur du dernier message du fil,
// plus la liste de tous les participants (Samuel le 27/11/2026). mailbox_threads.participants.from
// est range du plus recent au plus ancien (ss2i_008 et le worker ; verifie en prod le 27/11 :
// 1445 fils de l'Inbox sur 1445), donc from[0] est le dernier expediteur.

export type Person = { n?: string | null; e?: string | null };
export type Participants = { from?: Person[] | null } | null | undefined;

/** Auteur du dernier message du fil, ou null si aucun expediteur n'est connu. */
export function lastSender(p: Participants): Person | null {
	for (const x of p?.from ?? []) {
		if (x?.e && x.e.trim()) return x;
	}
	return null;
}

/**
 * Libelle de la colonne « De » : nom du dernier expediteur, sinon son adresse.
 * Avec `own` et `me`, une de mes adresses s'affiche `me` (« moi » dans la nouvelle interface).
 */
export function lastSenderLabel(
	p: Participants,
	opts: { own?: Set<string>; me?: string; unknown?: string } = {},
): string {
	const x = lastSender(p);
	if (!x) return opts.unknown ?? "(inconnu)";
	const e = String(x.e).trim();
	if (opts.me && opts.own?.has(e.toLowerCase())) return opts.me;
	return (x.n && x.n.trim()) || e;
}
