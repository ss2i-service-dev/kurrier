// Opening threads from the list (Settings > Opening mail). Shared between the server
// (lib/actions/open-prefs.ts) and the browser.
//
// By default nothing changes: a click opens the thread alone in the reading pane. For
// everyone, a middle click and Ctrl/Cmd+click open the thread in a browser tab, like a
// link (a row is not an <a>, they did nothing). Internal tabs (several threads open in
// the reading pane) are an option, with the gesture that opens one: the plain click (the
// middle click then keeps the browser tab) or the middle click (the plain click keeps
// opening a single thread).

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

/** single: thread alone in the reading pane; tab: internal tab; browser: browser tab. */
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
