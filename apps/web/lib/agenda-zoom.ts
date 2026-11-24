// ss2i : zoom de la grille horaire de l'agenda et heures de travail (embauche, debauche).
// Fonctions pures, testees par apps/web/test/agenda-zoom.ts.

/** Hauteur d'une heure (px) a chaque cran de zoom ; 44 = la grille d'avant le zoom. */
export const ZOOM_LEVELS = [32, 44, 64, 96, 144, 216] as const;
export const DEFAULT_HOUR_HEIGHT = 44;

/** Heures de travail par defaut (minutes depuis minuit). */
export const DEFAULT_WORK_START = 8 * 60;
export const DEFAULT_WORK_END = 18 * 60;

export function nearestZoom(h: number): number {
	if (!Number.isFinite(h)) return DEFAULT_HOUR_HEIGHT;
	let best: number = ZOOM_LEVELS[0];
	for (const z of ZOOM_LEVELS) if (Math.abs(z - h) < Math.abs(best - h)) best = z;
	return best;
}

/** Cran suivant (dir 1 : plus fin) ou precedent, borne aux extremes. */
export function zoomStep(h: number, dir: 1 | -1): number {
	const i = (ZOOM_LEVELS as readonly number[]).indexOf(nearestZoom(h));
	return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + dir))];
}

/** Minutes entre deux lignes secondaires de la grille (sous chaque heure pleine). */
export function gridLineStep(h: number): 15 | 30 {
	return h >= 96 ? 15 : 30;
}

/** Minutes entre deux heures ecrites dans la marge (16 px au moins entre deux). */
export function labelStep(h: number): 15 | 30 | 60 {
	if (h >= 144) return 15;
	if (h >= 64) return 30;
	return 60;
}

/** Heure tapee (« 08:30 », « 8h30 », « 8h », « 830 », « 17 ») en minutes, en 24 h ; null sinon. */
export function parseHourInput(raw: string): number | null {
	const s = raw.trim().toLowerCase();
	const m = /^(\d{1,2})(?:[:h.]?(\d{2}))?h?$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s);
	if (!m) return null;
	const h = Number(m[1]);
	const min = m[2] ? Number(m[2]) : 0;
	if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
	return h * 60 + min;
}

export function validWorkHours(start: number, end: number): boolean {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 * 60 && start < end;
}

/**
 * Defilement apres un changement de zoom : l'heure qui etait a `offsetY` px du haut de la zone
 * visible y reste.
 */
export function anchoredScrollTop(oldH: number, newH: number, scrollTop: number, offsetY: number): number {
	return Math.max(0, ((scrollTop + offsetY) / oldH) * newH - offsetY);
}

/**
 * Ctrl+molette (et pincement du pave tactile, qui arrive en ctrl+wheel a petits pas) : cumule
 * deltaY et rend un cran (1 : zoom avant, quand on pousse vers le haut) des que le cumul passe
 * le seuil.
 */
export function wheelZoomStep(acc: number, deltaY: number, threshold = 50): { acc: number; step: -1 | 0 | 1 } {
	const next = acc + deltaY;
	if (next <= -threshold) return { acc: 0, step: 1 };
	if (next >= threshold) return { acc: 0, step: -1 };
	return { acc: next, step: 0 };
}
