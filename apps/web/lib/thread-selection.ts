// Thread selection of a mail list, shared by the classic interface
// (webmail-list-item.tsx) and the modern one (k/thread-row.tsx). A click checks or unchecks
// a row and makes it the anchor; Shift+click applies the state of the clicked box to all
// rows between the anchor and it, in displayed order (orderedThreadIds), like Gmail.
// Merged update: the context setState replaces the whole state.
// Tested by apps/web/test/thread-selection.ts (run at image build).
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

// Shift+click on a row no longer highlights the text between the anchor and the clicked
// row (native browser selection). Blocking the mouse press with Shift prevents text
// selection without preventing the click; without Shift, nothing changes (selectable
// text, thread drag and drop).
export function preventShiftTextSelection(e: { shiftKey: boolean; preventDefault: () => void }) {
	if (e.shiftKey) e.preventDefault();
}
