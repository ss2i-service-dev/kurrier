// Ouverture d'un lien de visio (Teams, Google Meet, Zoom) depuis l'agenda ou le bandeau de rappel.
// Sur fixe : nouvel onglet (le lien garde target="_blank"). Sur telephone (pointeur grossier) :
// navigation dans l'onglet meme, pour qu'Android et iOS passent la main a l'appli Meet ou Teams ;
// target="_blank" peut empecher le passage a l'appli depuis Chrome Android et une PWA installee.
import type { MouseEvent } from "react";

export function openMeeting(e: MouseEvent<HTMLAnchorElement>, url: string): void {
	if (typeof window === "undefined" || !window.matchMedia?.("(pointer: coarse)").matches) return;
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	e.preventDefault();
	window.location.assign(url);
}
