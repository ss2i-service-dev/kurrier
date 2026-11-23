// resolveUids proves absence on Gmail (X-GM-EXT-1) without scanning a folder of more than 5,000
// messages: UID in the database without the message, SEARCH HEADER and X-GM-RAW empty.
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/resolve-uids-gmail.ts
import { resolveUids } from "../lib/imap/imap-resolve-uids";

let failed = 0;
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failed++;
};

function fake(opts: { gmail: boolean; msgs: Array<[number, string]>; exists?: number; rawFails?: boolean; fetchFails?: boolean }) {
	const msgs = new Map(opts.msgs);
	return {
		capabilities: new Map(opts.gmail ? [["X-GM-EXT-1", true]] : []),
		mailbox: { exists: opts.exists ?? msgs.size },
		async *fetch(range: string) {
			if (opts.fetchFails) throw new Error("connection lost");
			const uids = range === "1:*" ? [...msgs.keys()] : range.split(",").map(Number);
			for (const u of uids) if (msgs.has(u)) yield { uid: u, envelope: { messageId: `<${msgs.get(u)}>` } };
		},
		async search(q: any) {
			const mid = q.header ? String(q.header["message-id"]).replace(/[<>]/g, "") : q.gmraw ? (opts.rawFails ? null : q.gmraw.slice(12)) : null;
			if (mid === null) throw new Error("refused");
			return [...msgs].filter(([, m]) => m === mid).map(([u]) => u);
		},
	} as any;
}

async function main() {
	const row = { id: "r1", uid: 156547, messageId: "<abc@x>" };

	let absent = new Set<string>();
	let r = await resolveUids(fake({ gmail: true, msgs: [[1, "other@x"]], exists: 9000 }), [row], absent);
	check(r.size === 0 && absent.has("r1"), "Gmail, big folder, deleted message: absence proven");

	absent = new Set();
	r = await resolveUids(fake({ gmail: true, msgs: [[42, "abc@x"]], exists: 9000 }), [row], absent);
	check(r.get(42) === "r1" && !absent.size, "Gmail, message at another UID: found");

	absent = new Set();
	await resolveUids(fake({ gmail: true, msgs: [], exists: 9000, rawFails: true }), [row], absent);
	check(!absent.size, "Gmail, X-GM-RAW in error: no proof");

	absent = new Set();
	await resolveUids(fake({ gmail: true, msgs: [], exists: 9000, fetchFails: true }), [row], absent);
	check(!absent.size, "Gmail, FETCH of the UID in error: no proof");

	absent = new Set();
	await resolveUids(fake({ gmail: false, msgs: [], exists: 9000 }), [row], absent);
	check(!absent.size, "Stalwart, big folder: no proof (unchanged behaviour)");

	absent = new Set();
	await resolveUids(fake({ gmail: false, msgs: [[1, "other@x"]] }), [row], absent);
	check(absent.has("r1"), "Stalwart, small folder read in full: absence proven (unchanged)");

	if (failed) process.exit(1);
}
main();
