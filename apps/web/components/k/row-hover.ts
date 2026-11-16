"use client";
// SS2i : ligne de la liste survolee, deduite de la position du pointeur et non de
// mouseenter / :hover.
//
// Probleme (Jean-Baptiste, 16/11/2026) : supprimer, archiver ou epingler plusieurs
// fils d'affilee depuis les actions de survol ne marchait qu'une ou deux fois. La
// ligne cliquee quitte la liste, la suivante remonte sous le pointeur immobile :
// aucun mouseenter n'est emis tant que la souris ne bouge pas, si bien que ses
// actions (montees seulement apres un survol) n'existaient pas, et le clic suivant
// ouvrait le fil au lieu d'agir.
//
// Ici, la derniere position du pointeur est gardee ; a chaque mouvement, defilement
// ou changement de la liste (ligne retiree, deplacee), la ligne sous le pointeur
// est recalculee par elementFromPoint. Chaque ligne s'abonne a un booleen « suis-je
// la ligne survolee » : seules l'ancienne et la nouvelle ligne se redessinent.
import React from "react";

export const ROW_SELECTOR = ".k-row[data-thread-id]";

let x = -1;
let y = -1;
let hot: string | null = null;
const listeners = new Set<() => void>();
let frame = 0;
let installed = false;

/** Identifiant du fil de la ligne qui contient `el`, ou null. */
export function rowIdOf(el: Element | null): string | null {
	const row = el?.closest?.(ROW_SELECTOR) as HTMLElement | null | undefined;
	return row?.dataset.threadId ?? null;
}

function setHot(id: string | null) {
	if (id === hot) return;
	hot = id;
	listeners.forEach((l) => l());
}

function pick() {
	frame = 0;
	if (x < 0 || typeof document === "undefined") return setHot(null);
	setHot(rowIdOf(document.elementFromPoint(x, y)));
}

function schedule() {
	if (!frame && typeof window !== "undefined") frame = window.requestAnimationFrame(pick);
}

/**
 * Recalcule la ligne sous le pointeur apres un changement de la liste : au
 * prochain rendu, puis une fois les animations et rendus serveur passes.
 */
export function refreshRowHover() {
	if (typeof window === "undefined") return;
	schedule();
	window.setTimeout(schedule, 150);
	window.setTimeout(schedule, 500);
}

function install() {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const move = (e: PointerEvent) => {
		// Tactile : pas de survol.
		if (e.pointerType === "touch") return;
		x = e.clientX;
		y = e.clientY;
		schedule();
	};
	const leave = () => {
		x = y = -1;
		schedule();
	};
	window.addEventListener("pointermove", move, { passive: true });
	window.addEventListener("pointerdown", move, { passive: true });
	window.addEventListener("scroll", schedule, { passive: true, capture: true });
	document.documentElement.addEventListener("pointerleave", leave);
	window.addEventListener("blur", leave);
}

function subscribe(l: () => void) {
	install();
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

/** Vrai quand le pointeur est sur la ligne du fil `threadId`. */
export function useRowHot(threadId: string): boolean {
	return React.useSyncExternalStore(
		subscribe,
		() => hot === threadId,
		() => false,
	);
}
