// Pure function (tested by test/thread-dedupe.ts, without database or alias).
// The same mail can exist several times in a thread, one row per folder: the copy of the Sent
// folder and the copy received in the Inbox when an address in copy arrives in the same
// mailbox. The thread shows only one, by Message-ID.
// Messages come from the oldest to the most recent; the last copy is kept, in its place: it is
// the one fetchThreadMailbox falls back on for the folder of the thread.
// An empty Message-ID is never merged.
const key = (id: unknown) =>
	String(id ?? "")
		.trim()
		.replace(/^<|>$/g, "")
		.toLowerCase();

export function dedupeThreadMessages<T extends { messageId?: string | null }>(messages: T[]): T[] {
	const last = new Map<string, number>();
	messages.forEach((m, i) => {
		const k = key(m.messageId);
		if (k) last.set(k, i);
	});
	return messages.filter((m, i) => {
		const k = key(m.messageId);
		return !k || last.get(k) === i;
	});
}
