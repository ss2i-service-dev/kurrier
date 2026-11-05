"use client";
// Passes the user's shortcuts to the public script (public/keyboard-shortcuts.js
// reads window.__kurrierShortcutsConfig on every keystroke). Local copy to apply
// them from page load, then a read from the server.
import { useEffect, useSyncExternalStore } from "react";
import { fetchShortcutPrefs } from "@/lib/actions/shortcuts";
import {
	DEFAULT_PREFS,
	formatCombo,
	resolveBindings,
	sanitizePrefs,
	SHORTCUTS,
	type ShortcutId,
	type ShortcutPrefs,
} from "@/components/k/shortcuts-catalog";

const STORAGE_KEY = "k-shortcuts";

let current: ShortcutPrefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();

function apply(prefs: ShortcutPrefs) {
	current = prefs;
	const bindings = resolveBindings(prefs);
	const modern = typeof document !== "undefined" && document.documentElement.dataset.ui === "k";
	(window as any).__kurrierShortcutsConfig = {
		enabled: prefs.enabled,
		bindings,
		help: SHORTCUTS.filter((s) => modern || !s.modernOnly)
			.filter((s) => bindings[s.id].length)
			.map((s) => ({ label: s.en, keys: bindings[s.id].map((c) => formatCombo(c)) })),
		texts: { title: "Keyboard shortcuts", close: "Esc or ? to close · Customize them in Settings > Keyboard shortcuts" },
	};
	listeners.forEach((l) => l());
}

/** Saves locally and applies right away (after a server save). */
export function setShortcutPrefsLocal(prefs: ShortcutPrefs) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {}
	apply(prefs);
}

export function useShortcutPrefs(): ShortcutPrefs {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => current,
		() => DEFAULT_PREFS,
	);
}

/** First key of a shortcut, for tooltips; nothing when shortcuts are disabled. */
export function useShortcutHint(id: ShortcutId): string | undefined {
	const prefs = useShortcutPrefs();
	if (!prefs.enabled) return undefined;
	const first = resolveBindings(prefs)[id][0];
	return first ? formatCombo(first) : undefined;
}

/** While a key is being recorded in the settings, the script stops reacting. */
export function setShortcutRecording(on: boolean) {
	(window as any).__kurrierShortcutsRecording = on;
}

export default function KShortcutsConfig() {
	useEffect(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			apply(saved ? sanitizePrefs(JSON.parse(saved)) : DEFAULT_PREFS);
		} catch {
			apply(DEFAULT_PREFS);
		}
		let alive = true;
		fetchShortcutPrefs()
			.then((prefs) => {
				if (!alive) return;
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
				} catch {}
				apply(prefs);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	return null;
}
