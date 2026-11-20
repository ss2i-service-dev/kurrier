// SS2i : catalogue des raccourcis clavier (un seul jeu, celui de
// public/ss2i-shortcuts.js depuis les patches 0008 et 0053). Chaque utilisateur
// peut changer les touches dans Parametres > Raccourcis clavier ; seules ses
// modifications sont enregistrees (workspaces.meta.ss2iShortcuts[userId]).
//
// Une touche s'ecrit comme une combinaison normalisee : modificateurs dans
// l'ordre Ctrl, Alt, Maj, puis la touche (KeyboardEvent.key), ex. "c", "#",
// "Ctrl+Enter", "Shift+r", "ArrowDown". Meme logique dans le script public.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type ShortcutId =
	| "compose"
	| "reply"
	| "forward"
	| "archive"
	| "archiveFor"
	| "selectAll"
	| "delete"
	| "unread"
	| "search"
	| "help"
	| "next"
	| "prev"
	| "close"
	| "send";

export type ShortcutDef = {
	id: ShortcutId;
	group: "nav" | "read" | "organize" | "compose";
	en: string;
	fr: string;
	defaults: string[];
	/** Disponible seulement dans l'interface Outlook. */
	outlookOnly?: boolean;
};

export const SHORTCUTS: ShortcutDef[] = [
	{ id: "next", group: "nav", en: "Next conversation", fr: "Fil suivant", defaults: ["j", "ArrowDown"], outlookOnly: true },
	{ id: "prev", group: "nav", en: "Previous conversation", fr: "Fil précédent", defaults: ["k", "ArrowUp"], outlookOnly: true },
	{ id: "close", group: "nav", en: "Close the conversation", fr: "Fermer le fil ouvert", defaults: ["Escape"], outlookOnly: true },
	{ id: "search", group: "nav", en: "Search", fr: "Rechercher", defaults: ["/"] },
	{ id: "help", group: "nav", en: "Show shortcuts", fr: "Afficher les raccourcis", defaults: ["?"] },
	{ id: "reply", group: "read", en: "Reply", fr: "Répondre", defaults: ["r"] },
	{ id: "forward", group: "read", en: "Forward", fr: "Transférer", defaults: ["f"] },
	{ id: "unread", group: "read", en: "Mark as unread", fr: "Marquer comme non lu", defaults: ["u"] },
	{ id: "archive", group: "organize", en: "Archive (open or selected mail)", fr: "Archiver (le mail ouvert ou les mails cochés)", defaults: ["a"] },
	{ id: "archiveFor", group: "organize", en: "Archive for… (open or selected mail)", fr: "Archiver pour… (le mail ouvert ou les mails cochés)", defaults: ["Shift+a"] },
	{ id: "selectAll", group: "organize", en: "Select all mail in the list", fr: "Tout sélectionner (les mails de la liste affichée)", defaults: ["Ctrl+a"] },
	{ id: "delete", group: "organize", en: "Delete (open or selected mail)", fr: "Supprimer (le mail ouvert ou les mails cochés)", defaults: ["e", "#"] },
	{ id: "compose", group: "compose", en: "New message", fr: "Nouveau message", defaults: ["c"] },
	{ id: "send", group: "compose", en: "Send the message", fr: "Envoyer le message en cours", defaults: ["Ctrl+Enter"] },
];

export const GROUPS: { id: ShortcutDef["group"]; en: string; fr: string }[] = [
	{ id: "nav", en: "Navigation", fr: "Navigation" },
	{ id: "read", en: "Reading", fr: "Lecture" },
	{ id: "organize", en: "Organize", fr: "Organisation" },
	{ id: "compose", en: "Writing", fr: "Rédaction" },
];

export const MAX_KEYS_PER_SHORTCUT = 3;

/** Preferences enregistrees : seulement les ecarts aux valeurs par defaut. */
export type ShortcutPrefs = {
	enabled: boolean;
	keys: Partial<Record<ShortcutId, string[]>>;
};

export const DEFAULT_PREFS: ShortcutPrefs = { enabled: true, keys: {} };

const IDS = new Set<string>(SHORTCUTS.map((s) => s.id));
const COMBO = /^(?:(?:Ctrl|Alt|Shift)\+){0,3}[^+\s]{1,20}$|^(?:(?:Ctrl|Alt|Shift)\+){0,3}\+$/;

/** Combinaison normalisee d'un evenement clavier, null pour un modificateur seul. */
export function comboFromEvent(e: KeyboardEvent | ReactKeyboardEvent): string | null {
	let key = e.key;
	if (!key || ["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(key)) return null;
	if (key === " ") key = "Space";
	const altGr = typeof (e as KeyboardEvent).getModifierState === "function" && (e as KeyboardEvent).getModifierState("AltGraph");
	const mods: string[] = [];
	const single = key.length === 1;
	const letter = single && /\p{L}/u.test(key);
	// AltGr (clavier francais : # @ { }) remonte Ctrl+Alt sous Windows : c'est un caractere.
	if (!(single && !letter && altGr)) {
		if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
		if (e.altKey) mods.push("Alt");
	}
	// Maj ne compte que pour les lettres et les touches speciales : pour « ? » ou
	// « # », elle fait partie du caractere.
	if (e.shiftKey && (!single || letter)) mods.push("Shift");
	if (letter) key = key.toLowerCase();
	return [...mods, key].join("+");
}

function cleanCombo(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const s = v.trim();
	if (!s || s.length > 40 || !COMBO.test(s)) return null;
	return s;
}

/** Nettoie des preferences venues du client ou de la base. */
export function sanitizePrefs(raw: unknown): ShortcutPrefs {
	const out: ShortcutPrefs = { enabled: true, keys: {} };
	if (!raw || typeof raw !== "object") return out;
	const r = raw as Record<string, unknown>;
	if (r.enabled === false) out.enabled = false;
	const keys = r.keys && typeof r.keys === "object" ? (r.keys as Record<string, unknown>) : {};
	for (const [id, list] of Object.entries(keys)) {
		if (!IDS.has(id) || !Array.isArray(list)) continue;
		const combos = Array.from(new Set(list.map(cleanCombo).filter((c): c is string => !!c))).slice(0, MAX_KEYS_PER_SHORTCUT);
		out.keys[id as ShortcutId] = combos;
	}
	return out;
}

/** Touches effectives de chaque raccourci (personnalisees ou par defaut). */
export function resolveBindings(prefs: ShortcutPrefs): Record<ShortcutId, string[]> {
	const out = {} as Record<ShortcutId, string[]>;
	for (const s of SHORTCUTS) out[s.id] = prefs.keys[s.id] ?? s.defaults;
	return out;
}

/** Retire les entrees identiques aux valeurs par defaut avant enregistrement. */
export function compactPrefs(prefs: ShortcutPrefs): ShortcutPrefs {
	const keys: ShortcutPrefs["keys"] = {};
	for (const s of SHORTCUTS) {
		const k = prefs.keys[s.id];
		if (!k) continue;
		const same = k.length === s.defaults.length && k.every((c, i) => c === s.defaults[i]);
		if (!same) keys[s.id] = k;
	}
	return { enabled: prefs.enabled, keys };
}

const NAMES_FR: Record<string, string> = {
	Ctrl: "Ctrl",
	Alt: "Alt",
	Shift: "Maj",
	Enter: "Entrée",
	Escape: "Échap",
	Space: "Espace",
	Backspace: "Retour arrière",
	Delete: "Suppr",
	Tab: "Tab",
	ArrowDown: "↓",
	ArrowUp: "↑",
	ArrowLeft: "←",
	ArrowRight: "→",
	PageDown: "Page suiv.",
	PageUp: "Page préc.",
	Home: "Début",
	End: "Fin",
	Insert: "Inser",
};
const NAMES_EN: Record<string, string> = {
	Shift: "Shift",
	Escape: "Esc",
	Space: "Space",
	Delete: "Del",
	ArrowDown: "↓",
	ArrowUp: "↑",
	ArrowLeft: "←",
	ArrowRight: "→",
};

/** Libelle lisible d'une combinaison : « Ctrl + Entrée », « Maj + R », « ↓ ». */
export function formatCombo(combo: string, fr: boolean): string {
	const parts = combo === "+" ? ["+"] : combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
	const names = fr ? NAMES_FR : NAMES_EN;
	return parts
		.map((p) => names[p] ?? (p.length === 1 ? p.toUpperCase() : p))
		.join(" + ");
}

/** Une combinaison sans Ctrl ni Alt est ignoree pendant la saisie d'un texte. */
export function isPlainKey(combo: string): boolean {
	return !combo.split("+").slice(0, -1).some((m) => m === "Ctrl" || m === "Alt");
}
