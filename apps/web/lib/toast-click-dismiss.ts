// A click on a notification (sonner) closes it, except on its buttons and links: "Send now"
// and "Undo" keep their effect, a click elsewhere in the notification hides it without touching
// what it announces (a deferred send follows its course, its timer is independent of the
// notification).
// It goes through the close button of sonner (closeButton) rather than toast.dismiss: the <li>
// element does not carry the id of the toast, and the button triggers the proper closing of
// sonner (onDismiss, animation, stack recomputed).

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
