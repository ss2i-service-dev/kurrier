// Boite d'envoi (OI 10519) : mise en file d'un envoi (une ligne ledger draft_messages, puis le job
// SCHEDULED_JOB de meme id) et annulation arbitree par la ligne : la CAS scheduled -> canceled
// passe avant tout retrait de job et toute restauration du brouillon ; perdue, rien n'est
// restaure et l'etat reel est rendu. Faux ledger en memoire (memes CAS que le SQL).
// Depuis la racine :
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/outbox-cancel.ts
import assert from "node:assert/strict";
import { cancelSend, enqueueSend, messageIdFor } from "../../../packages/common/src/outbox";
import { SCHEDULED_JOB } from "../../../packages/common/src/schedule-send";

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

type Row = { id: string; status: string; payload: Record<string, any>; acceptanceUnknown?: boolean; deliveryState?: string };

// Faux ledger : chaque transition est un UPDATE ... WHERE status = attendu.
const ledger = (rows: Row[]) => {
	const byId = new Map(rows.map((r) => [r.id, { ...r }]));
	const cas = (id: string, from: string, to: string) => {
		const r = byId.get(id);
		if (!r || r.status !== from) return null;
		r.status = to;
		return { ...r };
	};
	return { byId, cas };
};

(async () => {
await test("messageIdFor : domaine de l'expediteur, comme nodemailer", () => {
	assert.equal(messageIdFor("moi@ss2i.example", "u-1"), "<u-1@ss2i.example>");
	assert.equal(messageIdFor('"Sam" <Sam@Exemple.FR>', "u-2"), "<u-2@exemple.fr>");
	assert.equal(messageIdFor("sans-domaine", "u-3"), "<u-3@localhost>");
});

await test("enqueueSend : ligne scheduled avec origine et Message-ID, puis job SCHEDULED_JOB de meme id", async () => {
	const inserted: any[] = [];
	const jobs: any[] = [];
	const now = new Date("2026-11-13T08:00:00Z");
	const sendAt = new Date("2026-11-13T08:00:10Z");
	const res = await enqueueSend(
		{
			payload: { draftMessageId: "d-1", subject: "s" },
			identityId: "i-1",
			mailboxId: "m-1",
			origin: "undo",
			sendAt,
			fromAddress: "moi@ss2i.example",
		},
		{
			uuid: () => "u-9",
			insertRow: async (v) => {
				inserted.push(v);
				return { id: "row-1", scheduledAt: v.scheduledAt };
			},
			addJob: async (name, data, opts) => void jobs.push({ name, data, opts }),
			deleteRow: async () => assert.fail("rien a retirer"),
		},
		now,
	);
	assert.equal(res.ok, true);
	assert.equal(inserted[0].status, "scheduled");
	assert.equal(inserted[0].origin, "undo");
	assert.equal(inserted[0].messageId, "<u-9@ss2i.example>");
	assert.equal(+inserted[0].scheduledAt, +sendAt);
	assert.equal(jobs[0].name, SCHEDULED_JOB);
	assert.equal(jobs[0].opts.jobId, "row-1");
	assert.equal(jobs[0].opts.delay, 10_000);
	assert.equal(jobs[0].data.imapDraftId, "d-1");
	assert.equal(jobs[0].opts.attempts ?? 1, 1, "jamais de renvoi automatique");
	if (res.ok) assert.equal(res.rowId, "row-1");
});

await test("enqueueSend : ajout du job en echec -> ligne retiree, erreur rendue", async () => {
	const deleted: string[] = [];
	const res = await enqueueSend(
		{ payload: {}, identityId: "i-1", mailboxId: "m-1", origin: "direct", sendAt: new Date(), fromAddress: "a@b.fr" },
		{
			insertRow: async (v) => ({ id: "row-2", scheduledAt: v.scheduledAt }),
			addJob: async () => {
				throw new Error("redis down");
			},
			deleteRow: async (id) => void deleted.push(id),
		},
	);
	assert.equal(res.ok, false);
	assert.deepEqual(deleted, ["row-2"]);
});

await test("enqueueSend : un nouvel envoi du meme brouillon ecarte ses echecs precedents", async () => {
	const superseded: string[] = [];
	await enqueueSend(
		{ payload: { draftMessageId: "d-7" }, identityId: "i-1", mailboxId: "m-1", origin: "undo", sendAt: new Date(), fromAddress: "a@b.fr" },
		{
			insertRow: async (v) => ({ id: "row-3", scheduledAt: v.scheduledAt }),
			addJob: async () => {},
			deleteRow: async () => {},
			supersede: async (draftId) => void superseded.push(draftId),
		},
	);
	assert.deepEqual(superseded, ["d-7"]);
});

const cancelIo = (l: ReturnType<typeof ledger>, id: string, calls: string[]) => ({
	casCancel: async () => l.cas(id, "scheduled", "canceled"),
	readRow: async () => (l.byId.get(id) ? { ...l.byId.get(id)! } : null),
	removeJob: async () => void calls.push("removeJob"),
	restore: async () => void calls.push("restore"),
});

await test("annuler contre claim du worker : un seul gagnant", async () => {
	for (const order of ["cancel-first", "claim-first"] as const) {
		const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
		const calls: string[] = [];
		let claimed: unknown = null;
		const claim = async () => (claimed = l.cas("r", "scheduled", "sending"));
		let res;
		if (order === "cancel-first") {
			res = await cancelSend(cancelIo(l, "r", calls));
			await claim();
		} else {
			await claim();
			res = await cancelSend(cancelIo(l, "r", calls));
		}
		const winners = (res.cancelled ? 1 : 0) + (claimed ? 1 : 0);
		assert.equal(winners, 1, order);
		if (order === "claim-first") assert.deepEqual(calls, [], "aucune restauration sans CAS gagnee");
	}
});

await test("annuler un envoi en cours ou parti : refus, etat reel, brouillon non restaure", async () => {
	for (const [status, state] of [["sending", "sending"], ["sent", "delivered"], ["failed", "failed"]] as const) {
		const l = ledger([{ id: "r", status, payload: {} }]);
		const calls: string[] = [];
		const res = await cancelSend(cancelIo(l, "r", calls));
		assert.equal(res.cancelled, false, status);
		assert.equal(res.state, state);
		assert.deepEqual(calls, [], status);
	}
});

await test("annuler gagne : job retire puis brouillon restaure ; deja annule : deverrouillage idempotent", async () => {
	const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
	const calls: string[] = [];
	const first = await cancelSend(cancelIo(l, "r", calls));
	assert.equal(first.cancelled, true);
	assert.deepEqual(calls, ["removeJob", "restore"]);
	const again = await cancelSend(cancelIo(l, "r", calls));
	assert.equal(again.cancelled, true);
	assert.deepEqual(calls, ["removeJob", "restore", "removeJob", "restore"]);
	assert.equal(l.byId.get("r")!.status, "canceled");
});

await test("annuler : un retrait de job ou une restauration en echec ne defait pas l'annulation", async () => {
	const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
	const res = await cancelSend({
		...cancelIo(l, "r", []),
		removeJob: async () => {
			throw new Error("redis down");
		},
		restore: async () => {
			throw new Error("imap down");
		},
	});
	assert.equal(res.cancelled, true);
	assert.equal(l.byId.get("r")!.status, "canceled");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
})();
