"use client";
// SS2i : onglets internes du volet lecture (option Parametres > Ouverture des
// mails, desactivee par defaut, voir open-prefs.ts).
//
// Un onglet = un fil (identifiant, adresse, objet). La liste des onglets est
// propre a chaque identite et gardee sur le poste (localStorage) : apres un
// rechargement on retrouve ses onglets. Le fil affiche reste celui de l'adresse
// (comme sans onglets) ; la barre ne fait que naviguer entre les adresses.
//
// Regle de navigation : un fil ouvert sans demander d'onglet (clic simple en
// mode « clic molette », raccourci j / k, fil suivant...) remplace l'onglet
// affiche, comme un lien suivi dans un onglet du navigateur. Si le fil affiche
// n'etait pas un onglet, aucun onglet n'est cree.
import { useSyncExternalStore } from "react";
import { DEFAULT_OPEN_PREFS, sanitizeOpenPrefs, type OpenPrefs } from "./open-prefs";

export type ReaderTab = { id: string; url: string; subject: string };

export const MAX_TABS = 12;

// ---- Regles (pures, testees par test/reader-tabs.ts) ----

/** Ajoute (ou met a jour) un onglet, juste apres `after` s'il est ouvert, sinon a la fin. */
export function addTab(tabs: ReaderTab[], tab: ReaderTab, after: string | null): ReaderTab[] {
	const i = tabs.findIndex((t) => t.id === tab.id);
	if (i >= 0) return tabs.map((t, j) => (j === i ? { ...t, url: tab.url, subject: tab.subject || t.subject } : t));
	const at = after ? tabs.findIndex((t) => t.id === after) : -1;
	const next = at >= 0 ? [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)] : [...tabs, tab];
	// Trop d'onglets : le plus ancien (a gauche) part, jamais celui qu'on ajoute ni `after`.
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

/** Onglet a afficher quand `id` se ferme : celui de droite, sinon celui de gauche. */
export function neighborOf(tabs: ReaderTab[], id: string): ReaderTab | null {
	const i = tabs.findIndex((t) => t.id === id);
	if (i < 0) return null;
	return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

/** Le fil `opened` vient de s'afficher, `previous` etait affiche avant. */
export function onThreadShown(tabs: ReaderTab[], previous: string | null, opened: ReaderTab): ReaderTab[] {
	if (tabs.some((t) => t.id === opened.id)) return addTab(tabs, opened, null);
	const i = previous ? tabs.findIndex((t) => t.id === previous) : -1;
	if (i < 0) return tabs;
	return tabs.map((t, j) => (j === i ? opened : t));
}

// ---- Reglage de l'utilisateur ----

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

/** Lecture hors React (gestionnaires de clic). */
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

// ---- Onglets ouverts ----

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

/** Identite affichee : ses onglets remplacent ceux de la precedente. */
export function setTabsScope(identityPublicId: string | null) {
	if (identityPublicId === scope) return;
	scope = identityPublicId;
	shown = null;
	tabs = identityPublicId ? readSaved(identityPublicId) : EMPTY;
	listeners.forEach((l) => l());
}

/** Objet d'un fil, retenu au rendu de sa ligne pour nommer l'onglet. */
export function rememberSubject(threadId: string, subject: string) {
	subjects.set(threadId, subject);
}

export function tabFor(threadId: string, url: string): ReaderTab {
	return { id: threadId, url, subject: subjects.get(threadId) ?? "" };
}

/** Ouvre (ou garde) un onglet pour le fil, a droite de l'onglet affiche. */
export function openTab(tab: ReaderTab) {
	commit(addTab(tabs, tab, shown));
}

/** Appele a chaque changement d'adresse (MailPanes). */
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
