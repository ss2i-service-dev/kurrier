"use client";
// SS2i : transmet les raccourcis de l'utilisateur au script public
// (public/ss2i-shortcuts.js lit window.__ss2iShortcutsConfig a chaque frappe).
// Copie locale pour les appliquer des le chargement, puis lecture du serveur.
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
let currentFr = false;
const listeners = new Set<() => void>();

function apply(prefs: ShortcutPrefs, fr: boolean) {
	current = prefs;
	currentFr = fr;
	const bindings = resolveBindings(prefs);
	const nouvelle = typeof document !== "undefined" && document.documentElement.dataset.ui === "ss2i";
	(window as any).__ss2iShortcutsConfig = {
		enabled: prefs.enabled,
		bindings,
		help: SHORTCUTS.filter((s) => nouvelle || !s.outlookOnly)
			.filter((s) => bindings[s.id].length)
			.map((s) => ({ label: fr ? s.fr : s.en, keys: bindings[s.id].map((c) => formatCombo(c, fr)) })),
		texts: fr
			? { title: "Raccourcis clavier", close: "Échap ou ? pour fermer · Personnalisables dans Paramètres > Raccourcis clavier" }
			: { title: "Keyboard shortcuts", close: "Esc or ? to close · Customize them in Settings > Keyboard shortcuts" },
	};
	listeners.forEach((l) => l());
}

/** Enregistre localement et applique tout de suite (apres un enregistrement serveur). */
export function setShortcutPrefsLocal(prefs: ShortcutPrefs) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {}
	apply(prefs, currentFr);
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

/** Premiere touche d'un raccourci, pour les infobulles ; rien s'ils sont desactives. */
export function useShortcutHint(id: ShortcutId): string | undefined {
	const prefs = useShortcutPrefs();
	if (!prefs.enabled) return undefined;
	const first = resolveBindings(prefs)[id][0];
	return first ? formatCombo(first, currentFr) : undefined;
}

/** Pendant l'enregistrement d'une touche dans les parametres, le script ne reagit plus. */
export function setShortcutRecording(on: boolean) {
	(window as any).__ss2iShortcutsRecording = on;
}

export default function KShortcutsConfig({ nouvelle }: { nouvelle: boolean }) {
	useEffect(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			apply(saved ? sanitizePrefs(JSON.parse(saved)) : DEFAULT_PREFS, nouvelle);
		} catch {
			apply(DEFAULT_PREFS, nouvelle);
		}
		let alive = true;
		fetchShortcutPrefs()
			.then((prefs) => {
				if (!alive) return;
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
				} catch {}
				apply(prefs, nouvelle);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [nouvelle]);
	return null;
}
