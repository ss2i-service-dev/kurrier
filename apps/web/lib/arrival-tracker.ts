// Unread marker on a thread read or open on screen when a message arrives in it afterwards
// (displaying the new message marks it read on the server right away). The baseline used to be
// last_activity_at, which a sent reply also changes (the thread moves up), as does the copy of
// our own mail received through an alias: the thread turned unread again.
// Baseline: number of messages of the thread in this folder; only one more message whose latest
// sender is not one of our addresses lights the marker. Pure function, tested by
// apps/web/test/own-reply-not-unread.ts.

export type ArrivalSnapshot = { count: number; lastFrom: string | null | undefined };

export function createArrivalTracker() {
	const baseline = new Map<string, { count: number; arrived: boolean }>();
	return {
		/** track: the thread is open or read on screen (starts the tracking if not yet tracked). */
		arrived(threadId: string, snap: ArrivalSnapshot, own: Set<string>, track: boolean): boolean {
			const id = String(threadId);
			const count = Number(snap.count) || 0;
			const base = baseline.get(id);
			if (!base) {
				if (track) baseline.set(id, { count, arrived: false });
				return false;
			}
			if (count > base.count) {
				const mine = own.has(String(snap.lastFrom ?? "").trim().toLowerCase());
				if (!mine) base.arrived = true;
			}
			base.count = count;
			return base.arrived;
		},
		reset(threadId: string) {
			baseline.delete(String(threadId));
		},
	};
}
