"use client";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

// Threads removed from the display on click (trash, archive, move, permanent deletion),
// without waiting for the worker. Without this, nothing moved on screen while the jobs
// ran one by one, and the selection vanished one thread at a time.
// Key = mailbox + thread: the same thread must stay visible in its destination mailbox.
// Bounded lifetime: if the move fails without a reported error, the thread comes back on
// the next display instead of disappearing for good.
const TTL_MS = 10 * 60 * 1000;
// Value = deadline and kind of departure. Archiving only takes the thread out of the
// Inbox: a view that also shows archives keeps it on screen.
const pending = new Map<string, { until: number; archive: boolean }>();
const listeners = new Set<() => void>();
let snapshot = new Map<string, boolean>();

const key = (mailboxId: string, threadId: string) => `${mailboxId}:${threadId}`;

function publish() {
	const now = Date.now();
	for (const [k, v] of pending) if (v.until < now) pending.delete(k);
	snapshot = new Map([...pending].map(([k, v]) => [k, v.archive]));
	listeners.forEach((l) => l());
}

export function hideThreads(mailboxId: string, threadIds: string[], archive = false) {
	const until = Date.now() + TTL_MS;
	threadIds.forEach((id) => pending.set(key(mailboxId, id), { until, archive }));
	publish();
}

export function showThreads(mailboxId: string, threadIds: string[]) {
	threadIds.forEach((id) => pending.delete(key(mailboxId, id)));
	publish();
}

// Hide immediately, run the action, and bring the threads back if it fails.
export async function optimisticMove<T>(
	mailboxId: string,
	threadIds: string[],
	run: () => Promise<T>,
	archive = false,
): Promise<T> {
	hideThreads(mailboxId, threadIds, archive);
	try {
		return await run();
	} catch (err) {
		showThreads(mailboxId, threadIds);
		throw err;
	}
}

// Undo window, like Gmail. Threads leave the list immediately, but the action is only
// sent to the server after UNDO_MS: "Undo" in the toast brings them back without any
// IMAP round trip having taken place.
const UNDO_MS = 6000;

// Modern interface (<html data-ui="k">): centered toast. Classic: unchanged.
const modern = () => typeof document !== "undefined" && document.documentElement.dataset.ui === "k";

export function moveWithUndo<T>({
	mailboxId,
	threadIds,
	message,
	run,
	onDone,
	onUndo,
	failure = "Action failed, messages restored",
	archive = false,
}: {
	mailboxId: string;
	threadIds: string[];
	message: string;
	run: () => Promise<T>;
	onDone?: (result: T) => void;
	// Called when the user undoes (modern interface: counters). Optional.
	onUndo?: () => void;
	failure?: string;
	archive?: boolean;
}) {
	if (!threadIds.length) return;
	hideThreads(mailboxId, threadIds, archive);
	const fire = () => {
		clearTimeout(timer);
		waiting.delete(fire);
		optimisticMove(mailboxId, threadIds, run, archive)
			.then((r) => onDone?.(r))
			.catch((e: any) =>
				toast.error(e?.message ?? failure, { position: "bottom-left" }),
			);
	};
	const timer = setTimeout(fire, UNDO_MS);
	waiting.add(fire);
	toast.success(message, {
		position: modern() ? "bottom-center" : "bottom-left",
		duration: UNDO_MS,
		action: {
			label: "Undo",
			onClick: () => {
				if (!waiting.delete(fire)) return; // already sent
				clearTimeout(timer);
				showThreads(mailboxId, threadIds);
				onUndo?.();
			},
		},
	});
}

// Tab closed or left during the undo window: send right away,
// otherwise the requested deletion would be silently lost.
const waiting = new Set<() => void>();
if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => [...waiting].forEach((f) => f()));
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const empty = new Map<string, boolean>();

// keepArchived: view that also contains archives, an archived thread stays there.
export function useHiddenThreads({ keepArchived = false }: { keepArchived?: boolean } = {}) {
	const hidden = useSyncExternalStore(subscribe, () => snapshot, () => empty);
	return (mailboxId: string, threadId: string) => {
		const k = key(mailboxId, threadId);
		return hidden.has(k) && !(keepArchived && hidden.get(k));
	};
}
