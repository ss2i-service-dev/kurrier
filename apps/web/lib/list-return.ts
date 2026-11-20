"use client";
// ss2i (Samuel le 05/11) : retour a la liste apres la lecture d'un mail, interface classique.
// La liste et le fil ouvert defilent dans le meme document : le fil s'affiche par-dessus la
// liste masquee (display: none), et au retour la liste reapparaissait a la hauteur atteinte
// dans le fil, perdue dans l'historique. On retient la position de chaque liste tant qu'elle
// est visible, on remonte en haut a l'ouverture d'un fil et on la retablit au retour.
// Repere : la ligne du dernier fil consulte reste marquee ; s'il a quitte la liste (archive,
// corbeille), c'est le fil consulte juste avant qui l'est.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const THREAD_IN_PATH = /\/threads\/([^/?#]+)/;
const HISTORY_MAX = 50;
const STORAGE_KEY = "ss2i-viewed-threads";

export const LAST_VIEWED_CLASS =
	"!bg-blue-500/10 dark:!bg-blue-400/15 shadow-[inset_3px_0_0_0_rgb(59,130,246)]";

export function listPathOf(pathname: string): string {
	return pathname.replace(/\/threads\/[^/]+\/?$/, "") || "/";
}

export function threadIdOf(pathname: string): string | null {
	const m = THREAD_IN_PATH.exec(pathname);
	return m ? decodeURIComponent(m[1]) : null;
}

/** Ajoute un fil en fin d'historique (le plus recent en dernier), sans doublon. */
export function pushViewed(history: string[], id: string, max = HISTORY_MAX): string[] {
	const next = history.filter((x) => x !== id);
	next.push(id);
	return next.slice(-max);
}

/** Dernier fil consulte encore affiche dans la liste, sinon null. */
export function pickLastViewed(history: string[], visibleIds: string[]): string | null {
	const visible = new Set(visibleIds);
	for (let i = history.length - 1; i >= 0; i--) if (visible.has(history[i])) return history[i];
	return null;
}

// Liste demontee a l'ouverture d'un fil (largeur mobile : la page du fil remplace la liste
// au lieu de s'afficher par-dessus) : au remontage, le hook repart sans memoire de ce qui
// precede. On retient la derniere liste quittee ; si c'est elle qui remonte, elle reprend
// sa position. Une autre liste montee entre-temps efface la marque.
let leftList: string | null = null;

export function noteListLeft(listKey: string) {
	leftList = listKey;
}

/** Vrai une seule fois si cette liste est celle qu'on vient de quitter. */
export function takeListReturn(listKey: string): boolean {
	const back = leftList === listKey;
	leftList = null;
	return back;
}

// Etat de la session de l'onglet : positions en memoire, historique aussi dans
// sessionStorage (le repere survit a un F5, pas a la fermeture de l'onglet).
const positions = new Map<string, number>();
let histories: Record<string, string[]> | null = null;

function loadHistories(): Record<string, string[]> {
	if (histories) return histories;
	histories = {};
	try {
		const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
		const parsed = raw ? JSON.parse(raw) : null;
		if (parsed && typeof parsed === "object") histories = parsed;
	} catch {
		// stockage indisponible ou illisible : historique en memoire seulement
	}
	return histories!;
}

function saveHistory(listKey: string, history: string[]) {
	const all = loadHistories();
	all[listKey] = history;
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
	} catch {
		// quota ou stockage refuse : sans consequence
	}
}

/**
 * A brancher sur une liste de fils de l'interface classique. Rend la ref a poser sur
 * l'element de la liste (celui qui est masque quand un fil est ouvert) et l'identifiant
 * du fil a marquer.
 */
// ss2i (20/11) : pane = le fil s'ouvre dans le panneau a defilement propre (thread-pane.tsx)
// et la liste reste montee dessous sans bouger : rien a remonter ni a retablir, seul le
// repere du dernier fil consulte sert encore.
export function useListReturn(pathname: string | null, visibleIds: string[], pane = false) {
	const path = pathname ?? "";
	const threadId = threadIdOf(path);
	const listKey = listPathOf(path);
	const ref = useRef<HTMLDivElement>(null);
	const keyRef = useRef(listKey);
	keyRef.current = listKey;
	const [history, setHistory] = useState<string[]>([]);

	// Position de la liste, relevee seulement quand elle est affichee : quand un fil
	// s'ouvre, la liste masquee raccourcit la page et le navigateur emet un scroll
	// qu'il ne faut pas prendre pour la position de la liste.
	useEffect(() => {
		const onScroll = () => {
			const el = ref.current;
			if (!el || el.getClientRects().length === 0) return;
			positions.set(keyRef.current, window.scrollY);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			window.removeEventListener("scroll", onScroll);
			noteListLeft(keyRef.current);
		};
	}, []);

	const previous = useRef<string | null | undefined>(undefined);
	useLayoutEffect(() => {
		const before = previous.current;
		previous.current = threadId;
		if (threadId) {
			const next = pushViewed(loadHistories()[listKey] ?? [], threadId);
			saveHistory(listKey, next);
			setHistory(next);
			if (pane) return;
			// Ouvert depuis la liste : le fil commence en haut de la page.
			if (before === null) window.scrollTo(0, 0);
			return;
		}
		setHistory(loadHistories()[listKey] ?? []);
		if (pane) return;
		// Premier rendu : retour d'un fil seulement si la liste avait ete demontee en l'ouvrant.
		const remounted = before === undefined && takeListReturn(listKey);
		if (!before && !remounted) return;
		// Retour d'un fil : la liste reprend sa position. Une seconde fois a l'image
		// suivante, au cas ou la navigation de Next remonte la page apres nous.
		const y = positions.get(listKey);
		if (y == null) return;
		window.scrollTo(0, y);
		const raf = requestAnimationFrame(() => window.scrollTo(0, y));
		return () => cancelAnimationFrame(raf);
	}, [threadId, listKey, pane]);

	return { ref, lastViewedId: pickLastViewed(history, visibleIds) };
}
