"use client";
// Optimistic mailbox state for the modern interface.
//
// Archive, delete, move: these go through lib/pending-moves (moveWithUndo), the
// same mechanism as the classic interface (thread removed on click, toast with
// Undo, action sent afterwards). This module only keeps what pending-moves does
// not cover: instant read / unread and star, the active thread, the new message
// in progress.
//
// Server actions (archive, delete, read/unread, star) go through the IMAP worker
// and, with refresh=true, wait for the database to reflect the change before
// redrawing: 0.3 to 5 s during which the screen did not move. Here, the UI
// applies the effect immediately, the action runs in the background with
// refresh=false, and a discreet refresh reconciles the display (sidebar
// counters) once activity settles. On failure, the effect is reverted and a
// message is shown.
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
	archiveThread,
	markAsRead,
	markAsUnread,
	moveToTrash,
	toggleStar,
} from "@/lib/actions/mailbox";
import { hideThreads, moveWithUndo } from "@/lib/pending-moves";
import { setThreadPinned } from "@/lib/actions/k-pins";
import { refreshUnreadBadge } from "@/components/k/new-mail-notifier";

type State = {
	read: Map<string, boolean>;
	starred: Map<string, boolean>;
	/** Pin state (thread -> pinned or not), applied before the server responds. */
	pinned: Map<string, boolean>;
	/** Thread being closed: the reading pane hides without waiting for the router. */
	closing: string | null;
	/** Open thread (or being opened): only its row and the previous one redraw. */
	active: string | null;
	/** New message in progress: it occupies the reading pane. */
	composing: boolean;
	/** Slot provided by the reading pane for the editor. */
	composeSlot: HTMLElement | null;
	/** Undoable send in progress: the editor stays mounted but the pane gives control back. */
	composeParked: boolean;
	/**
	 * Sidebar counter adjustments (folder -> delta), applied as soon as the action
	 	 * runs; each one is dropped when the server returns a value different from
	 	 * the one it was set against (the server has taken the action into account).
	 */
	countAdj: Map<string, { delta: number; base: number }>;
};

// Initial state, identical on the server: it is what React compares with the
// HTML during hydration (otherwise a row already marked active in the browser
// no longer matches the server render: hydration error).
const INITIAL: State = { read: new Map(), starred: new Map(), pinned: new Map(), closing: null, active: null, composing: false, composeSlot: null, composeParked: false, countAdj: new Map() };
let state: State = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
	state = { ...state, ...next };
	listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useMailStore<T>(select: (s: State) => T): T {
	return useSyncExternalStore(subscribe, () => select(state), () => select(INITIAL));
}

export function openCompose() {
	if (!state.composing) set({ composing: true });
}
export function closeCompose() {
	if (state.composing) set({ composing: false });
}
export function setComposeParked(v: boolean) {
	if (state.composeParked !== v) set({ composeParked: v });
}
export function setComposeSlot(el: HTMLElement | null) {
	if (state.composeSlot !== el) set({ composeSlot: el });
}

export function setClosingThread(threadId: string | null) {
	if (state.closing !== threadId) set({ closing: threadId });
}

/** Active thread: called on click (before the server responds) and on every URL change. */
export function setActiveThread(threadId: string | null) {
	if (state.active !== threadId) set({ active: threadId });
}

// Deferred refresh: a single router.refresh after a burst of actions.
let refresher: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function registerRefresher(fn: () => void) {
	refresher = fn;
}
export function scheduleRefresh(delay = 2500) {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		refresher?.();
		// Tab badge up to date after read, archive, delete...
		refreshUnreadBadge();
	}, delay);
}

/**
 * Called when new server data arrives for the list: drops the overrides the
  * server now confirms (read, starred).
 */
export function settle(rows: { threadId: string; unreadCount: number; starred: boolean }[]) {
	const byId = new Map(rows.map((r) => [String(r.threadId), r]));
	const read = new Map([...state.read].filter(([id, v]) => {
		const r = byId.get(id);
		return r ? (r.unreadCount === 0) !== v : false;
	}));
	const starred = new Map([...state.starred].filter(([id, v]) => {
		const r = byId.get(id);
		return r ? r.starred !== v : false;
	}));
	if (read.size !== state.read.size || starred.size !== state.starred.size) {
		set({ read, starred });
	}
}

/** Pins confirmed by the server: the matching overrides are dropped. */
export function settlePins(serverPinned: Set<string>) {
	if (!state.pinned.size) return;
	const pinned = new Map([...state.pinned].filter(([id, v]) => serverPinned.has(id) !== v));
	if (pinned.size !== state.pinned.size) set({ pinned });
}

async function run(
	apply: () => void,
	revert: () => void,
	call: () => Promise<unknown>,
	fail: string,
) {
	apply();
	try {
		await call();
		scheduleRefresh(800);
	} catch (e: any) {
		revert();
		toast.error(e?.message ?? fail, { position: "bottom-center" });
	}
}

const ids = (x: string | string[]) => (Array.isArray(x) ? x : [x]);

function setRead(threadIds: string[], value: boolean | null) {
	const read = new Map(state.read);
	threadIds.forEach((id) => {
		readBaseline.delete(String(id));
		if (value === null) read.delete(id);
		else read.set(id, value);
	});
	set({ read });
}

// Latest counters received from the server (provided by the sidebar).
let serverCounts = new Map<string, number>();

// Threads manually set back to unread during this session: automatic opening
// (reader already displayed, pane reloaded after a refresh) must not mark them
// read. Only an explicit action (click on the row, "Mark as read") reads them.
const manualUnread = new Set<string>();
export function isManuallyUnread(threadId: string) {
	return manualUnread.has(String(threadId));
}

// Thread read or open on screen: date of its last message at that moment. A
// message that arrives afterwards (open thread: it is marked read on the server
// as soon as it is displayed) gets the unread marker back, as a visual
// indicator, until the thread is next opened from the list (mailActions.read).
const readBaseline = new Map<string, string>();
export function arrivedSinceRead(threadId: string, lastActivityAt: unknown, track: boolean): boolean {
	const id = String(threadId);
	const now = String(lastActivityAt ?? "");
	const base = readBaseline.get(id);
	if (base === undefined) {
		if (track) readBaseline.set(id, now);
		return false;
	}
	return base !== now;
}

/** Thread already marked read on screen (on click in the list): no second marking. */
export function isMarkedRead(threadId: string) {
	return state.read.get(String(threadId)) === true;
}

/** The sidebar passes the server counters on every render. */
export function syncServerCounts(next: Map<string, number>) {
	serverCounts = next;
	if (!state.countAdj.size) return;
	const kept = new Map([...state.countAdj].filter(([id, a]) => (next.get(id) ?? 0) === a.base));
	if (kept.size !== state.countAdj.size) set({ countAdj: kept });
}

/** Adjusts a folder counter right away (negative n: fewer unread). */
export function adjustCount(mailboxId: string, n: number) {
	if (!n || !mailboxId) return;
	const countAdj = new Map(state.countAdj);
	const cur = countAdj.get(mailboxId);
	countAdj.set(mailboxId, { delta: (cur?.delta ?? 0) + n, base: cur?.base ?? serverCounts.get(mailboxId) ?? 0 });
	set({ countAdj });
}

export const mailActions = {
	/** unread: number of unread threads among those moved (folder counter). */
	archive(threadIds: string | string[], mailboxId: string, smtp: boolean, unread = 0) {
		const list = ids(threadIds);
		adjustCount(mailboxId, -unread);
		moveWithUndo({
			onUndo: () => adjustCount(mailboxId, unread),
			mailboxId,
			threadIds: list,
			message: list.length > 1 ? `${list.length} threads archived` : "Archived",
			// refresh=false: no waiting for the worker or a full page render; the
						// thread is already hidden, a discreet refresh follows.
						// archiving only takes the thread out of the Inbox
			archive: true,
			run: () => archiveThread(list, mailboxId, smtp, false),
			onDone: () => scheduleRefresh(),
			failure: "Archiving failed",
		});
	},
	trash(threadIds: string | string[], mailboxId: string, smtp: boolean, inTrash = false, unread = 0) {
		const list = ids(threadIds);
		adjustCount(mailboxId, -unread);
		moveWithUndo({
			onUndo: () => adjustCount(mailboxId, unread),
			mailboxId,
			threadIds: list,
			message: inTrash ? "Deleted permanently" : "Moved to trash",
			run: () => moveToTrash(list, mailboxId, smtp, false),
			onDone: () => scheduleRefresh(),
			failure: "Deletion failed",
		});
	},
	/** Move done elsewhere (folder, not spam): only hides. */
	hide(mailboxId: string, threadIds: string | string[]) {
		hideThreads(mailboxId, ids(threadIds));
	},
	/** unread: number of threads actually unread in the list (folder counter). */
	read(threadIds: string | string[], mailboxId: string, smtp: boolean, unread = 0) {
		const list = ids(threadIds);
		list.forEach((id) => manualUnread.delete(String(id)));
		const before = list.map((id) => state.read.get(id));
		return run(
			() => {
				setRead(list, true);
				adjustCount(mailboxId, -unread);
			},
			() => {
				list.forEach((id, i) => setRead([id], before[i] ?? null));
				adjustCount(mailboxId, unread);
			},
			() => markAsRead(list, mailboxId, smtp, false),
			"Action failed",
		);
	},
	/** read: number of read threads in the list that become unread again. */
	unread(threadIds: string | string[], mailboxId: string, smtp: boolean, read = 0) {
		const list = ids(threadIds);
		list.forEach((id) => manualUnread.add(String(id)));
		const before = list.map((id) => state.read.get(id));
		return run(
			() => {
				setRead(list, false);
				adjustCount(mailboxId, read);
			},
			() => {
				list.forEach((id, i) => setRead([id], before[i] ?? null));
				adjustCount(mailboxId, -read);
			},
			() => markAsUnread(list, mailboxId, smtp, false),
			"Action failed",
		);
	},
	/** Pin / unpin a thread: at the top of its folder, for yourself only. */
	pin(threadId: string, value: boolean) {
		const id = String(threadId);
		const before = state.pinned.get(id);
		return run(
			() => {
				const pinned = new Map(state.pinned);
				pinned.set(id, value);
				set({ pinned });
			},
			() => {
				const pinned = new Map(state.pinned);
				if (before === undefined) pinned.delete(id);
				else pinned.set(id, before);
				set({ pinned });
			},
			async () => {
				const res = await setThreadPinned(id, value);
				if (!res?.success) throw new Error(res?.error || "Action failed");
				toast.success(value ? "Thread pinned" : "Thread unpinned", { position: "bottom-center", duration: 2000 });
			},
			"Action failed",
		);
	},
	star(threadId: string, mailboxId: string, current: boolean, smtp: boolean) {
		const starred = new Map(state.starred);
		starred.set(threadId, !current);
		return run(
			() => set({ starred }),
			() => {
				const s = new Map(state.starred);
				s.delete(threadId);
				set({ starred: s });
			},
			() => toggleStar(threadId, mailboxId, current, smtp),
			"Action failed",
		);
	},
};
