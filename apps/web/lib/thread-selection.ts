// ss2i : selection des fils d'une liste de mails, commune a l'interface classique
// (webmail-list-item.tsx) et a la nouvelle (k/thread-row.tsx). Un clic coche ou decoche
// une ligne et en fait l'ancre ; Maj+clic applique l'etat de la case cliquee a toutes les
// lignes entre l'ancre et elle, dans l'ordre affiche (orderedThreadIds), comme Gmail.
// Mise a jour fusionnee : le setState du contexte remplace l'etat entier.
// Teste par apps/web/test/thread-selection.ts (lance au build de l'image).
export type ThreadSelectionState = {
	selectedThreadIds: Set<string>;
	lastSelectedThreadId?: string;
};

export function toggleThreadSelection<T extends Partial<ThreadSelectionState>>(
	prev: T | undefined,
	id: string,
	shiftKey: boolean,
	orderedThreadIds: readonly string[],
): T & ThreadSelectionState {
	const next = new Set(prev?.selectedThreadIds);
	const willCheck = !next.has(id);
	const anchor = prev?.lastSelectedThreadId;
	const from = anchor ? orderedThreadIds.indexOf(anchor) : -1;
	const to = orderedThreadIds.indexOf(id);
	const ids =
		shiftKey && from >= 0 && to >= 0
			? orderedThreadIds.slice(Math.min(from, to), Math.max(from, to) + 1)
			: [id];
	for (const t of ids) {
		if (willCheck) next.add(t);
		else next.delete(t);
	}
	return { ...(prev as T), selectedThreadIds: next, lastSelectedThreadId: id };
}
