// Folders without an unread counter. What you sent, what waits to be sent, your own drafts,
// the Archive and the Trash call for no attention: a "Sent (4)" counter means nothing.
// One rule for the server computation and the three sidebars.
export const NO_UNREAD_COUNT_KINDS = ["sent", "outbox", "drafts", "archive", "trash"] as const;

export function showsUnreadCount(kind: string | null | undefined): boolean {
	return !(NO_UNREAD_COUNT_KINDS as readonly string[]).includes(String(kind ?? ""));
}

// Counter of the sidebars fed by fetchDraftCounts (Classic and Three-column). Drafts shows its
// number of drafts there, pending sends excluded, not a number of unread messages.
export function showsSidebarCount(kind: string | null | undefined): boolean {
	return kind === "drafts" || showsUnreadCount(kind);
}

// Outbox: the number of visible sends (waiting, in progress, failed), never unread counts;
// nothing at zero; red as soon as a send needs an action.
export function outboxSidebarCount(c: { total: number; alert: number } | null | undefined): { n: number; alert: boolean } | null {
	if (!c || c.total <= 0) return null;
	return { n: c.total, alert: c.alert > 0 };
}
