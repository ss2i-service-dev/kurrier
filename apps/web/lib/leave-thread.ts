"use client";
// ss2i : sortie d'un fil ouvert (corbeille, archive, non lu) vers la liste, sans attente.
// router.push passait par la file d'actions du routeur Next, qui execute les actions
// serveur une par une (markAsRead a l'ouverture, avec revalidatePath, puis les autres) :
// la liste ne revenait qu'une fois toute la file videe, jusqu'a 45 s et plus.
// Quand le fil a ete ouvert depuis la liste (route interceptee @thread), la liste est
// deja montee sous le fil, seulement masquee d'apres l'URL (webmail-list, thread-slot) :
// changer l'URL par history.pushState, que Next synchronise avec usePathname, la
// reaffiche tout de suite. Le rafraichissement des compteurs suit en arriere-plan.
// Fil ouvert par son URL directe : pas de liste montee, router.push comme avant.
type RouterLike = { push: (href: string) => void; refresh: () => void };

export const LIST_MARKER = "data-ss2i-mail-list";

export function leaveThreadToList(router: RouterLike, pathname: string) {
	const target = pathname.replace(/\/threads\/[^/]+\/?$/, "") || "/";
	if (typeof document !== "undefined" && document.querySelector(`[${LIST_MARKER}]`)) {
		window.history.pushState(null, "", target);
		router.refresh();
		return;
	}
	router.push(target);
}
