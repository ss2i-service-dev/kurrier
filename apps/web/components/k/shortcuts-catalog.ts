// Catalog of keyboard shortcuts (a single set, the one in
// public/keyboard-shortcuts.js). Each user can change the keys in
// Settings > Keyboard shortcuts; only their changes are stored
// (workspaces.meta.prefShortcuts[userId]).
//
// A key is written as a normalized combination: modifiers in the order Ctrl,
// Alt, Shift, then the key (KeyboardEvent.key), e.g. "c", "#", "Ctrl+Enter",
// "Shift+r", "ArrowDown". Same logic in the public script.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type ShortcutId =
	| "compose"
	| "reply"
	| "forward"
	| "archive"
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
	defaults: string[];
	/** Only available in the modern interface. */
	modernOnly?: boolean;
};

export const SHORTCUTS: ShortcutDef[] = [
	{ id: "next", group: "nav", en: "Next conversation", defaults: ["j", "ArrowDown"], modernOnly: true },
	{ id: "prev", group: "nav", en: "Previous conversation", defaults: ["k", "ArrowUp"], modernOnly: true },
	{ id: "close", group: "nav", en: "Close the conversation", defaults: ["Escape"], modernOnly: true },
	{ id: "search", group: "nav", en: "Search", defaults: ["/"] },
	{ id: "help", group: "nav", en: "Show shortcuts", defaults: ["?"] },
	{ id: "reply", group: "read", en: "Reply", defaults: ["r"] },
	{ id: "forward", group: "read", en: "Forward", defaults: ["f"] },
	{ id: "unread", group: "read", en: "Mark as unread", defaults: ["u"] },
	{ id: "archive", group: "organize", en: "Archive (open or selected mail)", defaults: ["a"] },
	{ id: "delete", group: "organize", en: "Delete (open or selected mail)", defaults: ["e", "#"] },
	{ id: "compose", group: "compose", en: "New message", defaults: ["c"] },
	{ id: "send", group: "compose", en: "Send the message", defaults: ["Ctrl+Enter"] },
];

export const GROUPS: { id: ShortcutDef["group"]; en: string }[] = [
	{ id: "nav", en: "Navigation" },
	{ id: "read", en: "Reading" },
	{ id: "organize", en: "Organize" },
	{ id: "compose", en: "Writing" },
];

export const MAX_KEYS_PER_SHORTCUT = 3;

/** Stored preferences: only the differences from the defaults. */
export type ShortcutPrefs = {
	enabled: boolean;
	keys: Partial<Record<ShortcutId, string[]>>;
};

export const DEFAULT_PREFS: ShortcutPrefs = { enabled: true, keys: {} };

const IDS = new Set<string>(SHORTCUTS.map((s) => s.id));
const COMBO = /^(?:(?:Ctrl|Alt|Shift)\+){0,3}[^+\s]{1,20}$|^(?:(?:Ctrl|Alt|Shift)\+){0,3}\+$/;

/** Normalized combination of a keyboard event, null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent | ReactKeyboardEvent): string | null {
	let key = e.key;
	if (!key || ["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(key)) return null;
	if (key === " ") key = "Space";
	const altGr = typeof (e as KeyboardEvent).getModifierState === "function" && (e as KeyboardEvent).getModifierState("AltGraph");
	const mods: string[] = [];
	const single = key.length === 1;
	const letter = single && /\p{L}/u.test(key);
	// AltGr (e.g. on French keyboards: # @ { }) reports Ctrl+Alt on Windows: it is a character.
	if (!(single && !letter && altGr)) {
		if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
		if (e.altKey) mods.push("Alt");
	}
	// Shift only counts for letters and special keys: for "?" or "#", it is part
	// of the character.
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

/** Cleans preferences coming from the client or the database. */
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

/** Effective keys of each shortcut (custom or default). */
export function resolveBindings(prefs: ShortcutPrefs): Record<ShortcutId, string[]> {
	const out = {} as Record<ShortcutId, string[]>;
	for (const s of SHORTCUTS) out[s.id] = prefs.keys[s.id] ?? s.defaults;
	return out;
}

/** Drops entries identical to the defaults before saving. */
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

const NAMES: Record<string, string> = {
	Shift: "Shift",
	Escape: "Esc",
	Space: "Space",
	Delete: "Del",
	ArrowDown: "↓",
	ArrowUp: "↑",
	ArrowLeft: "←",
	ArrowRight: "→",
};

/** Readable label of a combination: "Ctrl + Enter", "Shift + R", "↓". */
export function formatCombo(combo: string): string {
	const parts = combo === "+" ? ["+"] : combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
	return parts
		.map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p))
		.join(" + ");
}

/** A combination without Ctrl or Alt is ignored while typing text. */
export function isPlainKey(combo: string): boolean {
	return !combo.split("+").slice(0, -1).some((m) => m === "Ctrl" || m === "Alt");
}
