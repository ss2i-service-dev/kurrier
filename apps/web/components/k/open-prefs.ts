// SS2i : ouverture des fils depuis la liste (Parametres > Ouverture des mails).
// Partage entre le serveur (lib/actions/open-prefs.ts) et le navigateur.
//
// Par defaut, rien ne change : un clic ouvre le fil seul dans le volet lecture.
// Pour tout le monde, le clic molette et Ctrl/Cmd+clic ouvrent le fil dans un
// onglet du navigateur, comme un lien (une ligne n'est pas un <a>, ils ne
// faisaient rien). Les onglets internes (plusieurs fils ouverts dans le volet
// lecture) sont une option a activer, avec le geste qui en ouvre un : le clic
// normal (le clic molette garde alors l'onglet du navigateur) ou le clic molette
// (le clic normal garde l'ouverture d'un seul fil).

export type OpenGesture = "click" | "middle";
export type OpenPrefs = { tabs: boolean; gesture: OpenGesture };

export const DEFAULT_OPEN_PREFS: OpenPrefs = { tabs: false, gesture: "click" };

export function sanitizeOpenPrefs(raw: unknown): OpenPrefs {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		tabs: r.tabs === true,
		gesture: r.gesture === "middle" ? "middle" : "click",
	};
}

/** single : fil seul dans le volet lecture ; tab : onglet interne ; browser : onglet du navigateur. */
export type RowOpen = "single" | "tab" | "browser";

export function resolveRowOpen(
	prefs: OpenPrefs,
	e: { button: number; ctrlKey?: boolean; metaKey?: boolean },
): RowOpen | null {
	if (e.button === 1) return prefs.tabs && prefs.gesture === "middle" ? "tab" : "browser";
	if (e.button !== 0) return null;
	if (e.ctrlKey || e.metaKey) return "browser";
	return prefs.tabs && prefs.gesture === "click" ? "tab" : "single";
}
