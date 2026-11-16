// ss2i (16/11) : resolveUids prouve l'absence chez Gmail (X-GM-EXT-1) sans balayer un dossier
// de plus de 5 000 messages : UID en base sans le message, SEARCH HEADER et X-GM-RAW vides.
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
			if (opts.fetchFails) throw new Error("coupure");
			const uids = range === "1:*" ? [...msgs.keys()] : range.split(",").map(Number);
			for (const u of uids) if (msgs.has(u)) yield { uid: u, envelope: { messageId: `<${msgs.get(u)}>` } };
		},
		async search(q: any) {
			const mid = q.header ? String(q.header["message-id"]).replace(/[<>]/g, "") : q.gmraw ? (opts.rawFails ? null : q.gmraw.slice(12)) : null;
			if (mid === null) throw new Error("refus");
			return [...msgs].filter(([, m]) => m === mid).map(([u]) => u);
		},
	} as any;
}

async function main() {
	const row = { id: "r1", uid: 156547, messageId: "<abc@x>" };

	let absent = new Set<string>();
	let r = await resolveUids(fake({ gmail: true, msgs: [[1, "autre@x"]], exists: 9000 }), [row], absent);
	check(r.size === 0 && absent.has("r1"), "Gmail, gros dossier, message supprime : absence prouvee");

	absent = new Set();
	r = await resolveUids(fake({ gmail: true, msgs: [[42, "abc@x"]], exists: 9000 }), [row], absent);
	check(r.get(42) === "r1" && !absent.size, "Gmail, message a un autre UID : retrouve");

	absent = new Set();
	await resolveUids(fake({ gmail: true, msgs: [], exists: 9000, rawFails: true }), [row], absent);
	check(!absent.size, "Gmail, X-GM-RAW en erreur : pas de preuve");

	absent = new Set();
	await resolveUids(fake({ gmail: true, msgs: [], exists: 9000, fetchFails: true }), [row], absent);
	check(!absent.size, "Gmail, FETCH de l'UID en erreur : pas de preuve");

	absent = new Set();
	await resolveUids(fake({ gmail: false, msgs: [], exists: 9000 }), [row], absent);
	check(!absent.size, "Stalwart, gros dossier : pas de preuve (comportement inchange)");

	absent = new Set();
	await resolveUids(fake({ gmail: false, msgs: [[1, "autre@x"]] }), [row], absent);
	check(absent.has("r1"), "Stalwart, petit dossier lu en entier : absence prouvee (inchange)");

	if (failed) process.exit(1);
}
main();
