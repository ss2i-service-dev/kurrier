// Boite d'envoi (OI 10519) : mise en file d'un envoi (une ligne ledger draft_messages, puis le job
// SCHEDULED_JOB de meme id) et annulation arbitree par la ligne : la CAS scheduled -> canceled
// passe avant tout retrait de job et toute restauration du brouillon ; perdue, rien n'est
// restaure et l'etat reel est rendu. Faux ledger en memoire (memes CAS que le SQL).
// Depuis la racine :
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/outbox-cancel.ts
import assert from "node:assert/strict";
import { cancelSend, enqueueSend, messageIdFor, sendNowPlanOf } from "../../../packages/common/src/outbox";
import { DRAFT_MAYBE_SENT_ERROR } from "../../../packages/common/src/draft-send";
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

type Row = {
	id: string;
	status: string;
	payload: Record<string, any>;
	acceptanceUnknown?: boolean;
	deliveryState?: string;
	acceptedAt?: Date | null;
	sentRowId?: string | null;
	dismissedAt?: Date | null;
};

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

await test("enqueueSend : marque du brouillon posee avant le job ; refusee -> ligne retiree sans job ; job en echec -> marque retiree", async () => {
	// Un envoi immediat qui echoue vite (marque retiree par le worker) ne doit pas voir sa marque
	// reposee apres coup : elle passe avant l'ajout du job.
	const calls: string[] = [];
	const base = {
		insertRow: async (v: any) => (calls.push("insert"), { id: "row-4", scheduledAt: v.scheduledAt }),
		addJob: async () => void calls.push("job"),
		deleteRow: async () => void calls.push("delete"),
		unmark: async () => void calls.push("unmark"),
	};
	const input = { payload: { draftMessageId: "d-8" }, identityId: "i-1", mailboxId: "m-1", origin: "undo" as const, sendAt: new Date(), fromAddress: "a@b.fr" };
	const ok = await enqueueSend(input, { ...base, mark: async (row) => (calls.push(`mark:${row.id}`), true) });
	assert.equal(ok.ok, true);
	assert.deepEqual(calls, ["insert", "mark:row-4", "job"]);

	calls.length = 0;
	const refused = await enqueueSend(input, { ...base, mark: async () => false });
	assert.equal(refused.ok, false);
	assert.deepEqual(calls, ["insert", "delete"], "pas de job sans marque");

	calls.length = 0;
	const noJob = await enqueueSend(input, {
		...base,
		mark: async () => true,
		addJob: async () => {
			throw new Error("redis down");
		},
	});
	assert.equal(noJob.ok, false);
	assert.deepEqual(calls, ["insert", "delete", "unmark"]);
});

// Envoi precedent du meme brouillon interrompu (le serveur n'a pas repondu : peut-etre parti) :
// le renvoyer depuis l'editeur doublerait peut-etre le mail, et l'ecarter en douce effacerait la
// seule trace. Refus explicite, aucune ligne, aucun job, rien d'ecarte.
await test("enqueueSend : brouillon dont un envoi est interrompu -> refus « peut-être déjà parti », rien n'est cree", async () => {
	const calls: string[] = [];
	const io = {
		insertRow: async (v: any) => (calls.push("insert"), { id: "row-5", scheduledAt: v.scheduledAt }),
		addJob: async () => void calls.push("job"),
		deleteRow: async () => void calls.push("delete"),
		mark: async () => (calls.push("mark"), true),
		supersede: async () => void calls.push("supersede"),
	};
	const input = { payload: { draftMessageId: "d-9" }, identityId: "i-1", mailboxId: "m-1", origin: "undo" as const, sendAt: new Date(), fromAddress: "a@b.fr" };
	const asked: string[] = [];
	const res = await enqueueSend(input, { ...io, interrupted: async (id: string) => (asked.push(id), true) });
	assert.deepEqual(res, { ok: false, error: DRAFT_MAYBE_SENT_ERROR, maybeSent: true });
	assert.deepEqual(asked, ["d-9"]);
	assert.deepEqual(calls, []);
	assert.equal(DRAFT_MAYBE_SENT_ERROR, "Ce mail est peut-être déjà parti : vérifiez dans la Boîte d'envoi");
	// Sans envoi interrompu, ou sans brouillon d'origine : envoi normal.
	assert.equal((await enqueueSend(input, { ...io, interrupted: async () => false })).ok, true);
	const asked2: string[] = [];
	const direct = await enqueueSend({ ...input, payload: {} }, { ...io, interrupted: async (id: string) => (asked2.push(id), true) });
	assert.equal(direct.ok, true);
	assert.deepEqual(asked2, []);
});

const cancelIo = (l: ReturnType<typeof ledger>, id: string, calls: string[]) => ({
	casCancel: async () => l.cas(id, "scheduled", "canceled"),
	readRow: async () => (l.byId.get(id) ? { ...l.byId.get(id)! } : null),
	removeJob: async () => void calls.push("removeJob"),
	restore: async () => void calls.push("restore"),
	unlock: async () => void calls.push("unlock"),
	settle: async (action: string) => void calls.push(`settle:${action}`),
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
		assert.ok(!calls.includes("restore") && !calls.includes("removeJob"), status);
	}
});

// Marque restee sur le brouillon alors que la ligne est terminee (nettoyage apres envoi,
// retrait de marque ou restauration en echec) : Annuler ne restaure rien mais remet le brouillon
// d'aplomb, sinon il reste verrouille pour toujours.
await test("annuler perdu sur une ligne terminee : le brouillon est nettoye (parti) ou deverrouille", async () => {
	const at = new Date("2026-11-13T09:00:00Z");
	const cases: [Row, string[]][] = [
		[{ id: "r", status: "sending", payload: {} }, []],
		[{ id: "r", status: "sent", payload: {}, acceptedAt: at, sentRowId: null }, []],
		[{ id: "r", status: "sent", payload: {}, acceptedAt: at, sentRowId: "m-1" }, ["settle:delete"]],
		[{ id: "r", status: "failed", payload: {} }, ["settle:unlock"]],
		[{ id: "r", status: "failed", payload: {}, acceptanceUnknown: true, dismissedAt: at }, ["settle:unlock"]],
		[{ id: "r", status: "sent", payload: {}, acceptedAt: at, sentRowId: "m-1", dismissedAt: at, deliveryState: "rejected" }, ["settle:unlock"]],
	];
	for (const [row, expected] of cases) {
		const l = ledger([row]);
		const calls: string[] = [];
		const res = await cancelSend(cancelIo(l, "r", calls));
		assert.equal(res.cancelled, false, JSON.stringify(row));
		assert.deepEqual(calls, expected, JSON.stringify(row));
	}
	// Un menage en echec ne change pas la reponse.
	const l = ledger([{ id: "r", status: "failed", payload: {} }]);
	const res = await cancelSend({
		...cancelIo(l, "r", []),
		settle: async () => {
			throw new Error("db down");
		},
	});
	assert.deepEqual(res, { cancelled: false, state: "failed" });
});

await test("annuler gagne : job retire puis brouillon restaure ; deja annule : deverrouillage seul, jamais de restauration sans CAS gagnee", async () => {
	const l = ledger([{ id: "r", status: "scheduled", payload: {} }]);
	const calls: string[] = [];
	const first = await cancelSend(cancelIo(l, "r", calls));
	assert.equal(first.cancelled, true);
	assert.deepEqual(calls, ["removeJob", "restore"]);
	// Second clic (onglet perime) : le contenu de la ligne ne reecrit pas un brouillon modifie depuis.
	const again = await cancelSend(cancelIo(l, "r", calls));
	assert.equal(again.cancelled, true);
	assert.deepEqual(calls, ["removeJob", "restore", "removeJob", "unlock"]);
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

// Job en echec et ligne non retiree (base indisponible a son tour) : la ligne scheduled sans job
// resterait « programmee » pour rien (et rejouee par la reprise au boot) ; elle passe en canceled.
await test("enqueueSend : job en echec puis ligne non retiree -> ligne annulee, jamais scheduled sans job", async () => {
	const calls: string[] = [];
	const res = await enqueueSend(
		{ payload: { draftMessageId: "d-10" }, identityId: "i-1", mailboxId: "m-1", origin: "undo", sendAt: new Date(), fromAddress: "a@b.fr" },
		{
			insertRow: async (v: any) => (calls.push("insert"), { id: "row-6", scheduledAt: v.scheduledAt }),
			addJob: async () => {
				throw new Error("redis down");
			},
			deleteRow: async () => {
				calls.push("delete");
				throw new Error("db down");
			},
			cancelRow: async (id: string) => void calls.push(`cancel:${id}`),
		},
	);
	assert.equal(res.ok, false);
	assert.deepEqual(calls, ["insert", "delete", "cancel:row-6"]);
});

// « Envoyer maintenant » : la ligne decide. Job en attente -> promu ; job disparu, en echec ou
// termine alors que la ligne est encore scheduled -> rajoute depuis la ligne ; ligne sortie de
// scheduled (partie, annulee) ou job deja en cours -> rien.
await test("sendNowPlanOf : promouvoir, rajouter depuis la ligne, ou rien", () => {
	assert.equal(sendNowPlanOf("delayed", "scheduled"), "promote");
	assert.equal(sendNowPlanOf("delayed", null), "promote", "envoi d'avant le ledger (undo-send-*), sans ligne");
	for (const state of [null, "unknown", "failed", "completed"]) {
		assert.equal(sendNowPlanOf(state, "scheduled"), "readd", String(state));
	}
	for (const state of ["waiting", "active", "prioritized"]) {
		assert.equal(sendNowPlanOf(state, "scheduled"), "none", state);
	}
	for (const status of ["sending", "sent", "canceled", "failed"]) {
		assert.equal(sendNowPlanOf("delayed", status), "none", status);
		assert.equal(sendNowPlanOf(null, status), "none", status);
	}
	assert.equal(sendNowPlanOf(null, null), "none");
	assert.equal(sendNowPlanOf("failed", null), "none");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
})();
