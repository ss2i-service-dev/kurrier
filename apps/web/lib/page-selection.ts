// ss2i : texte selectionne dans la page au moment d'ouvrir la recherche (Samuel le 05/11 :
// « quand on selectionne un texte et qu'on clique dans la zone de recherche, il faudrait que
// ca pre-remplisse le texte qu'on a selectionne »). Le corps d'un mail est rendu dans une
// shadow root (email-viewer.tsx) : selon le navigateur, window.getSelection() n'y voit rien,
// on interroge alors chaque shadow root ouverte (getSelection, propre a Chromium).

export const SEARCH_SELECTION_MAX = 200;

export function normalizeSearchSelection(raw: string | null | undefined): string {
	const text = (raw ?? "").replace(/\s+/g, " ").trim();
	if (text.length <= SEARCH_SELECTION_MAX) return text;
	const cut = text.slice(0, SEARCH_SELECTION_MAX);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > SEARCH_SELECTION_MAX / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

type ShadowWithSelection = ShadowRoot & { getSelection?: () => Selection | null };

const readSelection = (sel: Selection | null | undefined) =>
	sel && !sel.isCollapsed ? sel.toString() : "";

export function selectedPageText(doc: Document = document): string {
	const main = normalizeSearchSelection(readSelection(doc.getSelection()));
	if (main) return main;
	for (const el of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
		const root = el.shadowRoot as ShadowWithSelection | null;
		if (!root?.getSelection) continue;
		const text = normalizeSearchSelection(readSelection(root.getSelection()));
		if (text) return text;
	}
	return "";
}
