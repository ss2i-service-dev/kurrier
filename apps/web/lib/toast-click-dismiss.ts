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
