// Move at message granularity (sender blocking). A thread can mix messages from the
// blocked sender and others: only the former are moved. Pure function, shared by the
// worker (moveMail) and tested without a database.

// `source`: all messages of the affected threads that are in the source folder;
// `onlyIds`: the messages to move. Returns those to move (present in the source folder),
// the threads fully moved (no message left in the source) and the partial threads.
export function planMessageMove(
	source: Array<{ id: string; threadId: string }>,
	onlyIds: Iterable<string>,
) {
	const only = new Set(onlyIds);
	const moving = source.filter((m) => only.has(m.id));
	const movingThreads = new Set(moving.map((m) => m.threadId));
	const staying = new Set(source.filter((m) => !only.has(m.id)).map((m) => m.threadId));
	const fullThreadIds: string[] = [];
	const partialThreadIds: string[] = [];
	for (const t of movingThreads) (staying.has(t) ? partialThreadIds : fullThreadIds).push(t);
	return { messageIds: moving.map((m) => m.id), fullThreadIds, partialThreadIds };
}
