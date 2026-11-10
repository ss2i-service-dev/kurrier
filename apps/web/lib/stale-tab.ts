// ss2i : onglet perime (nouvelle version deployee, action serveur inconnue). Un seul etat
// partage par le surveillant de version et le pouls des nouveaux messages : des qu'il est
// pose, components/common/version-watcher.tsx couvre toute la page et recharge.
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
