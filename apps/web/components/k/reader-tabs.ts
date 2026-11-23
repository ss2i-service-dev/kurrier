"use client";
// Internal tabs of the reading pane (option Settings > Opening mail, off by default,
// see open-prefs.ts).
//
// A tab = a thread (id, address, subject). The list of tabs belongs to each identity and
// is kept on this device (localStorage): after a reload the tabs are still there. The
// thread displayed stays the one of the address (as without tabs); the bar only
// navigates between addresses.
//
// Navigation rule: a thread opened without asking for a tab (plain click in "middle
// click" mode, j / k shortcut, next thread...) replaces the displayed tab, like a link
// followed in a browser tab. If the displayed thread was not a tab, no tab is created.
import { useSyncExternalStore } from "react";
import { DEFAULT_OPEN_PREFS, sanitizeOpenPrefs, type OpenPrefs } from "./open-prefs";

export type ReaderTab = { id: string; url: string; subject: string };

export const MAX_TABS = 12;

// ---- Rules (pure, tested by test/reader-tabs.ts) ----

/** Adds (or updates) a tab, right after `after` if it is open, otherwise at the end. */
export function addTab(tabs: ReaderTab[], tab: ReaderTab, after: string | null): ReaderTab[] {
	const i = tabs.findIndex((t) => t.id === tab.id);
	if (i >= 0) return tabs.map((t, j) => (j === i ? { ...t, url: tab.url, subject: tab.subject || t.subject } : t));
	const at = after ? tabs.findIndex((t) => t.id === after) : -1;
	const next = at >= 0 ? [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)] : [...tabs, tab];
	// Too many tabs: the oldest (on the left) goes, never the one being added nor `after`.
	while (next.length > MAX_TABS) {
		const k = next.findIndex((t) => t.id !== tab.id && t.id !== after);
		next.splice(k, 1);
	}
	return next;
}

export function removeTabs(tabs: ReaderTab[], ids: string[]): ReaderTab[] {
	const drop = new Set(ids.map(String));
	return tabs.some((t) => drop.has(t.id)) ? tabs.filter((t) => !drop.has(t.id)) : tabs;
}

/** Tab to display when `id` closes: the one on the right, otherwise the one on the left. */
export function neighborOf(tabs: ReaderTab[], id: string): ReaderTab | null {
	const i = tabs.findIndex((t) => t.id === id);
	if (i < 0) return null;
	return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

/** Thread `opened` has just been displayed, `previous` was displayed before. */
export function onThreadShown(tabs: ReaderTab[], previous: string | null, opened: ReaderTab): ReaderTab[] {
	if (tabs.some((t) => t.id === opened.id)) return addTab(tabs, opened, null);
	const i = previous ? tabs.findIndex((t) => t.id === previous) : -1;
	if (i < 0) return tabs;
	return tabs.map((t, j) => (j === i ? opened : t));
}

// ---- User setting ----

const PREFS_KEY = "k-open-prefs";
let prefs: OpenPrefs = DEFAULT_OPEN_PREFS;
const prefListeners = new Set<() => void>();

export function setOpenPrefsLocal(next: OpenPrefs, persist = true) {
	prefs = next;
	if (persist) {
		try {
			localStorage.setItem(PREFS_KEY, JSON.stringify(next));
		} catch {}
	}
	prefListeners.forEach((l) => l());
}

export function loadOpenPrefsLocal() {
	try {
		const saved = localStorage.getItem(PREFS_KEY);
		if (saved) setOpenPrefsLocal(sanitizeOpenPrefs(JSON.parse(saved)), false);
	} catch {}
}

/** Read outside React (click handlers). */
export function getOpenPrefs(): OpenPrefs {
	return prefs;
}

export function useOpenPrefs(): OpenPrefs {
	return useSyncExternalStore(
		(l) => {
			prefListeners.add(l);
			return () => prefListeners.delete(l);
		},
		() => prefs,
		() => DEFAULT_OPEN_PREFS,
	);
}

// ---- Open tabs ----

const EMPTY: ReaderTab[] = [];
let scope: string | null = null;
let tabs: ReaderTab[] = EMPTY;
let shown: string | null = null;
const listeners = new Set<() => void>();
const subjects = new Map<string, string>();

const storageKey = (s: string) => `k-tabs:${s}`;

function commit(next: ReaderTab[]) {
	if (next === tabs) return;
	tabs = next;
	if (scope) {
		try {
			if (next.length) localStorage.setItem(storageKey(scope), JSON.stringify(next));
			else localStorage.removeItem(storageKey(scope));
		} catch {}
	}
	listeners.forEach((l) => l());
}

function readSaved(s: string): ReaderTab[] {
	try {
		const raw = JSON.parse(localStorage.getItem(storageKey(s)) ?? "[]");
		if (!Array.isArray(raw)) return EMPTY;
		return raw
			.filter((t) => t && typeof t.id === "string" && typeof t.url === "string")
			.map((t) => ({ id: t.id, url: t.url, subject: String(t.subject ?? "") }))
			.slice(-MAX_TABS);
	} catch {
		return EMPTY;
	}
}

/** Identity displayed: its tabs replace those of the previous one. */
export function setTabsScope(identityPublicId: string | null) {
	if (identityPublicId === scope) return;
	scope = identityPublicId;
	shown = null;
	tabs = identityPublicId ? readSaved(identityPublicId) : EMPTY;
	listeners.forEach((l) => l());
}

/** Subject of a thread, remembered when its row renders, to name the tab. */
export function rememberSubject(threadId: string, subject: string) {
	subjects.set(threadId, subject);
}

export function tabFor(threadId: string, url: string): ReaderTab {
	return { id: threadId, url, subject: subjects.get(threadId) ?? "" };
}

/** Opens (or keeps) a tab for the thread, to the right of the displayed tab. */
export function openTab(tab: ReaderTab) {
	commit(addTab(tabs, tab, shown));
}

/** Called on each address change (MailPanes). */
export function threadShown(tab: ReaderTab | null) {
	if (tab && prefs.tabs) commit(onThreadShown(tabs, shown, tab));
	shown = tab?.id ?? null;
}

export function closeTabs(ids: string[]) {
	commit(removeTabs(tabs, ids));
}

export function getTabs(): ReaderTab[] {
	return tabs;
}

export function useReaderTabs(): ReaderTab[] {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => tabs,
		() => EMPTY,
	);
}
