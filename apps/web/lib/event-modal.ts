// ss2i : place du detail d'un evenement de l'agenda (Samuel le 10/11 : « elle est toute petite
// par rapport au reste du calendrier [...] une mini-modale »). Fenetre centree, environ 60 %
// de la largeur (900 px au moins, 1200 au plus) et 80 % de la hauteur, marges de 16 px.
// Test : apps/web/test/event-modal.ts.
const MARGIN = 16;

export function eventModalBox(vw: number, vh: number) {
	const width = Math.round(Math.min(vw - 2 * MARGIN, Math.min(1200, Math.max(900, vw * 0.6))));
	const height = Math.round(Math.min(vh - 2 * MARGIN, Math.max(560, vh * 0.8)));
	return { width, height, left: (vw - width) / 2, top: (vh - height) / 2 };
}
