"use client";
// Leaving an open thread (trash, archive, unread) back to the list, without waiting.
// router.push went through the Next router action queue, which runs server actions one by
// one (markAsRead on open, with revalidatePath, then the others): the list only came back
// once the whole queue was drained, up to 45 s and more.
// When the thread was opened from the list (intercepted @thread route), the list is already
// mounted under the thread, only hidden according to the URL (webmail-list, thread-slot):
// changing the URL with history.pushState, which Next syncs with usePathname, shows it again
// immediately. The counters refresh follows in the background.
// Thread opened by its direct URL: no list mounted, router.push as before.
type RouterLike = { push: (href: string) => void; refresh: () => void };

export const LIST_MARKER = "data-k-mail-list";

export function leaveThreadToList(router: RouterLike, pathname: string) {
	const target = pathname.replace(/\/threads\/[^/]+\/?$/, "") || "/";
	if (typeof document !== "undefined" && document.querySelector(`[${LIST_MARKER}]`)) {
		window.history.pushState(null, "", target);
		router.refresh();
		return;
	}
	router.push(target);
}
