// Text selected in the page when the search box is opened, used to prefill it. A mail body
// is rendered in a shadow root (email-viewer.tsx): depending on the browser,
// window.getSelection() sees nothing there, so every open shadow root is queried
// (getSelection, Chromium-specific).

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
