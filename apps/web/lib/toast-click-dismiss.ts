// Un clic sur une notification (sonner) la ferme, sauf sur ses boutons et ses liens :
// « Envoyer maintenant » et « Annuler » gardent leur effet, un clic ailleurs dans la
// notification la masque sans toucher a ce qu'elle annonce (l'envoi differe suit son cours,
// son minuteur est independant de la notification).
// On passe par le bouton de fermeture de sonner (closeButton) plutot que toast.dismiss :
// l'element <li> ne porte pas l'identifiant du toast, et le bouton declenche la fermeture
// propre de sonner (onDismiss, animation, pile recalculee).

type ClickTarget = {
	closest(selector: string): ClickTarget | null;
	querySelector(selector: string): ClickTarget | null;
};

const INTERACTIVE = "button, a, input, textarea, select, [data-button], [role=button]";

export function toastCloseButtonForClick<T extends ClickTarget>(target: T | null): T | null {
	if (!target || typeof target.closest !== "function") return null;
	const toast = target.closest("[data-sonner-toast]");
	if (!toast) return null;
	if (toast.closest('[data-dismissible="false"]') === toast) return null;
	if (target.closest(INTERACTIVE)) return null;
	return toast.querySelector("[data-close-button]") as T | null;
}

// Fermeture « mignonne » (Samuel le 10/11 : « un truc qui eclate [...] que ce soit un peu
// mignon ») : la notification gonfle puis s'efface (keyframes ss2i-toast-pop de globals.css)
// pendant qu'une gerbe de bulles part du point du clic. Le bouton de fermeture de sonner est
// actionne a la fin de l'animation.
export const TOAST_POP_MS = 220;

const BUBBLE_COLORS = ["#f472b6", "#facc15", "#34d399", "#60a5fa", "#a78bfa", "#fb923c"];

export type BurstParticle = { dx: number; dy: number; size: number; color: string; delay: number };

export function burstParticles(count = 14, rand: () => number = Math.random): BurstParticle[] {
	return Array.from({ length: count }, (_, i) => {
		const angle = (i / count) * 2 * Math.PI + (rand() - 0.5) * 0.5;
		const dist = 28 + rand() * 44;
		return {
			dx: Math.cos(angle) * dist,
			dy: Math.sin(angle) * dist,
			size: 4 + rand() * 7,
			color: BUBBLE_COLORS[i % BUBBLE_COLORS.length],
			delay: rand() * 40,
		};
	});
}
