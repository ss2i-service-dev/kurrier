// Stale tab (new version deployed, unknown Server Action): one state, read by
// components/common/version-watcher.tsx, which covers the whole page and reloads once it is set.
export type StaleState = { served: string | null; autoReload: boolean } | null;

let state: StaleState = null;
const listeners = new Set<() => void>();

export function forceReload(served: string | null = null, autoReload = true) {
	if (state && !(autoReload && !state.autoReload)) return;
	state = { served, autoReload };
	for (const l of listeners) l();
}

export function subscribeStale(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function getStale(): StaleState {
	return state;
}

// The watcher is mounted only when the user turned on "Reload the page after an update": while
// it runs, the new mail pulse leaves the stale tab to it (no second notice).
let watching = false;

export function setWatching(on: boolean) {
	watching = on;
}

export function isWatching() {
	return watching;
}
