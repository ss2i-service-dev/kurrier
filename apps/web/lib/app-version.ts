// Build version and forced reload after a redeploy.
// Without it, a tab opened before a redeploy keeps the old bundle and its Server Action ids:
// Next no longer finds them and shows "An unexpected response was received from the server."

// Build number: UTC date and time, "YYYYMMDD.HHMM".
export function formatBuildVersion(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
		`.${p(date.getUTCHours())}${p(date.getUTCMinutes())}`
	);
}

export type NewVersionAction = "none" | "reload" | "block";

// loaded: version of the tab's bundle; served: version announced by the server;
// reloadedFor: version the tab already reloaded for (sessionStorage).
// A stale tab is never left usable: forced reload, even while a mail is being written (drafts
// have a local copy, lib/draft-backup.ts, resumed on load). If the reload already happened for
// this version without changing the bundle (cache), the page stays blocked with a button, so
// there is no loop of reloads.
export function onNewVersion(s: { loaded: string; served: string | null; reloadedFor: string | null }): NewVersionAction {
	if (!s.served || s.served === s.loaded) return "none";
	return s.reloadedFor === s.served ? "block" : "reload";
}

// Bound on automatic reloads, whatever the cause (new version, unknown or failed Server Action):
// at most one per RELOAD_WINDOW_MS per tab (sessionStorage timestamp). The reload of a failed
// action has no version to compare, so without it a server that keeps failing (old and new
// instances mixed during a rolling deploy) would reload the tab over and over. Beyond it the
// veil stays with its "Reload now" button. Storage unavailable: no automatic reload.
export const RELOAD_WINDOW_MS = 5 * 60_000;
const RELOAD_AT_KEY = "kurrier-auto-reload-at";

export function takeReloadSlot(
	store: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null | undefined,
	now: number,
): boolean {
	try {
		if (!store) return false;
		const last = Number(store.getItem(RELOAD_AT_KEY) || 0);
		if (now - last < RELOAD_WINDOW_MS) return false;
		store.setItem(RELOAD_AT_KEY, String(now));
		return true;
	} catch {
		return false;
	}
}

// Next.js answers an unknown Server Action (old bundle) with a 404 carrying this header.
export function isStaleActionResponse(headers: { get(name: string): string | null } | null | undefined): boolean {
	return headers?.get("x-nextjs-action-not-found") === "1";
}

// Server Action call (Next-Action header) that failed. Behind a reverse proxy that replaces
// error responses with its own page, the header of Next is lost and an unknown action cannot be
// told from a real error: hence an immediate check of the version.
type HeaderBag = Headers | Record<string, string> | [string, string][] | null | undefined;
export function isFailedActionCall(headers: HeaderBag, res: { ok: boolean; status: number }): boolean {
	if (res.ok || !headers) return false;
	if (typeof (headers as Headers).get === "function") return !!(headers as Headers).get("next-action");
	const entries = Array.isArray(headers) ? headers : Object.entries(headers);
	return entries.some(([k, v]) => k.toLowerCase() === "next-action" && !!v);
}
