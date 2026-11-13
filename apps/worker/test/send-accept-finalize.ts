// Boite d'envoi (OI 10519) : pipeline d'envoi du worker (apps/worker/lib/send/pipeline.ts).
// Ordre : claim (CAS scheduled -> sending), rendu hors transaction, SMTP avec le Message-ID de
// la ligne, un seul UPDATE « accepte » (sent, accepted_at), puis finalisation idempotente (copie
// Envoyes) dans une transaction, effets non rejouables (eml S3, recherche, CRM) apres le commit.
// Apres un 250, plus rien n'ecrit « failed » : un mail parti n'est jamais propose au renvoi.
// Faux ledger en memoire avec les memes CAS que le SQL ; le faux SMTP echoue si une transaction
// est ouverte (aucun effet irreversible dans une transaction qui peut encore echouer).
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/send-accept-finalize.ts
import assert from "node:assert/strict";
import {
	finalizeSent,
	legacyLedgerRow,
	runSend,
	sweepLedger,
	type FinalizeIo,
	type LedgerRow,
	type LedgerStore,
	type SendDeps,
} from "../lib/send/pipeline";
import { outboxActionsOf } from "../../../packages/common/src/outbox-state";

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const NOW = new Date("2026-11-13T09:00:00Z");
const ledgerRow = (over: Partial<LedgerRow> = {}): LedgerRow => ({
	id: "row-1",
	status: "scheduled",
	payload: { draftMessageId: "imap-1", sentMailboxId: "mb-sent" },
	identityId: "ident-1",
	messageId: "<u-1@ss2i.example>",
	acceptedAt: null,
	acceptanceUnknown: false,
	deliveryState: "none",
	rendered: null,
	sentRowId: null,
	updatedAt: NOW,
	...over,
});

type Smtp = { success: boolean; MessageId?: string; error?: string; response?: string; ambiguous?: boolean };

// Faux monde : ledger, table messages (unique (mailbox_id, message_id)), SMTP, S3.
const world = (rows: LedgerRow[], opts: { smtp?: (messageId: string) => Promise<Smtp> | Smtp } = {}) => {
	const ledger = new Map(rows.map((r) => [r.id, { ...r }]));
	const msgs: { id: string; mailboxId: string; messageId: string }[] = [];
	const attachments: string[] = [];
	const marks: { imapDraftId: string; error: string }[] = [];
	const smtpCalls: string[] = [];
	const afterCommits: { messageRowId: string; inserted: boolean }[] = [];
	let inTx = false;
	let failAccept = false;
	let failAfterCommit = false;
	let failInsert = false;
	const clone = (r: LedgerRow | undefined) => (r ? { ...r } : null);
	const cas = (id: string, ok: (r: LedgerRow) => boolean, set: Partial<LedgerRow>) => {
		const r = ledger.get(id);
		if (!r || !ok(r)) return null;
		Object.assign(r, set, { updatedAt: NOW });
		return { ...r };
	};
	const store: LedgerStore = {
		get: async (id) => clone(ledger.get(id)),
		claim: async (id) => cas(id, (r) => r.status === "scheduled", { status: "sending" }),
		fail: async (id, f) =>
			cas(id, (r) => r.status === "sending", { status: "failed", acceptanceUnknown: f.ambiguous }),
		accept: async (id, a) => {
			if (failAccept) throw new Error("db down");
			return cas(
				id,
				(r) => r.status === "sending" || (r.status === "failed" && r.acceptanceUnknown && !r.acceptedAt),
				{ status: "sent", acceptedAt: NOW, acceptanceUnknown: false, messageId: a.messageId, rendered: a.rendered },
			);
		},
		staleSending: async (before) =>
			[...ledger.values()].filter((r) => r.status === "sending" && !r.acceptedAt && r.updatedAt < before).map((r) => ({ ...r })),
		unfinalized: async (before) =>
			[...ledger.values()]
				.filter((r) => r.status === "sent" && r.acceptedAt && r.acceptedAt < before && r.deliveryState === "none" && !r.sentRowId)
				.map((r) => ({ ...r })),
	};
	const finalizeIo: FinalizeIo = {
		transaction: async (fn) => {
			const snapshot = { ledger: [...ledger.values()].map((r) => ({ ...r })), msgs: msgs.length, attachments: attachments.length };
			inTx = true;
			try {
				return await fn({
					lockRow: async (id) => clone(ledger.get(id)),
					ensureThread: async (row) => String(row.rendered?.threadId ?? "thread-new"),
					insertMessage: async (row) => {
						if (failInsert) throw new Error("insert failed");
						const mailboxId = String(row.rendered!.mailboxId);
						const existing = msgs.find((m) => m.mailboxId === mailboxId && m.messageId === row.messageId);
						if (existing) return { id: existing.id, inserted: false };
						const id = `msg-${msgs.length + 1}`;
						msgs.push({ id, mailboxId, messageId: String(row.messageId) });
						return { id, inserted: true };
					},
					insertAttachments: async (messageRowId) => void attachments.push(messageRowId),
					upsertThreadItem: async () => {},
					setSentRowId: async (id, messageRowId) => void Object.assign(ledger.get(id)!, { sentRowId: messageRowId }),
				});
			} catch (err) {
				for (const r of snapshot.ledger) ledger.set(r.id, r);
				msgs.length = snapshot.msgs;
				attachments.length = snapshot.attachments;
				throw err;
			} finally {
				inTx = false;
			}
		},
		afterCommit: async (f) => {
			assert.equal(inTx, false, "effets apres le commit");
			afterCommits.push({ messageRowId: f.messageRowId, inserted: f.inserted });
			if (failAfterCommit) throw new Error("S3 down");
		},
	};
	const deps: SendDeps = {
		store,
		render: async (row) => ({
			from: "Moi <moi@ss2i.example>",
			imapDraftId: row.payload.draftMessageId ?? null,
			rendered: { mailboxId: "mb-sent", subject: "Objet", threadId: null },
			send: async (messageId) => {
				assert.equal(inTx, false, "SMTP dans une transaction ouverte");
				smtpCalls.push(messageId);
				// Laisse l'autre claim concurrent s'executer pendant le « SMTP ».
				await new Promise((r) => setTimeout(r, 5));
				return opts.smtp ? opts.smtp(messageId) : { success: true, MessageId: messageId, response: "250 2.0.0 OK queued" };
			},
		}),
		newMessageId: () => "<gen-1@ss2i.example>",
		finalize: (rowId) => finalizeSent(rowId, finalizeIo),
		markFailed: async (row, error) => void marks.push({ imapDraftId: String(row.payload.draftMessageId), error }),
		log: () => {},
	};
	return {
		ledger,
		msgs,
		attachments,
		marks,
		smtpCalls,
		afterCommits,
		store,
		finalizeIo,
		deps,
		set failAccept(v: boolean) {
			failAccept = v;
		},
		set failAfterCommit(v: boolean) {
			failAfterCommit = v;
		},
		set failInsert(v: boolean) {
			failInsert = v;
		},
	};
};

(async () => {
await test("envoi accepte : sent, accepted_at, Message-ID de la ligne, une copie Envoyes", async () => {
	const w = world([ledgerRow()]);
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "sent");
	assert.ok(row.acceptedAt);
	assert.deepEqual(w.smtpCalls, ["<u-1@ss2i.example>"]);
	assert.equal(w.msgs.length, 1);
	assert.equal(row.sentRowId, "msg-1");
	assert.equal(row.rendered?.subject, "Objet", "corps fige sur la ligne");
	assert.deepEqual(w.marks, []);
});

await test("250 puis S3 en echec : ligne sent avec accepted_at, SMTP une fois, Reessayer refuse", async () => {
	const w = world([ledgerRow()]);
	w.failAfterCommit = true;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "sent");
	assert.ok(row.acceptedAt);
	assert.equal(w.smtpCalls.length, 1);
	assert.equal(outboxActionsOf(row).retry, false);
	assert.deepEqual(w.marks, [], "aucune marque d'echec apres un 250");
});

await test("250 puis copie Envoyes en echec : ligne sent sans sent_row_id, rejouee une seule fois", async () => {
	const w = world([ledgerRow()]);
	w.failInsert = true;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	assert.equal(w.ledger.get("row-1")!.status, "sent");
	assert.equal(w.ledger.get("row-1")!.sentRowId, null);
	assert.equal(w.msgs.length, 0);
	w.failInsert = false;
	const first = await finalizeSent("row-1", w.finalizeIo);
	const again = await finalizeSent("row-1", w.finalizeIo);
	assert.equal(w.msgs.length, 1);
	assert.equal(first?.already, false);
	assert.equal(again?.already, true);
	assert.equal(w.afterCommits.length, 1, "effets apres commit une seule fois");
	assert.equal(w.smtpCalls.length, 1);
});

await test("copie deja presente pour (mailbox_id, message_id) : fusion, ni doublon ni pieces jointes", async () => {
	const w = world([ledgerRow()]);
	w.msgs.push({ id: "msg-imap", mailboxId: "mb-sent", messageId: "<u-1@ss2i.example>" });
	await runSend("row-1", w.deps);
	assert.equal(w.msgs.length, 1);
	assert.equal(w.ledger.get("row-1")!.sentRowId, "msg-imap");
	assert.deepEqual(w.attachments, []);
	assert.deepEqual(w.afterCommits, [{ messageRowId: "msg-imap", inserted: false }]);
});

await test("deux claims concurrents : un seul SMTP", async () => {
	const w = world([ledgerRow()]);
	const [a, b] = await Promise.all([runSend("row-1", w.deps), runSend("row-1", w.deps)]);
	assert.equal(w.smtpCalls.length, 1);
	assert.deepEqual([a.outcome, b.outcome].sort(), ["sent", "skipped"]);
	assert.equal(w.msgs.length, 1);
});

await test("ligne annulee ou deja partie : rien n'est envoye", async () => {
	for (const status of ["canceled", "sent", "failed", "sending"]) {
		const w = world([ledgerRow({ status })]);
		const res = await runSend("row-1", w.deps);
		assert.equal(res.outcome, "skipped", status);
		assert.equal(w.smtpCalls.length, 0, status);
	}
});

await test("rendu en echec (avant tout SMTP) : failed certain, brouillon marque", async () => {
	const w = world([ledgerRow()]);
	w.deps.render = async () => {
		throw new Error("Attachment not allowed: x.pdf");
	};
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "failed");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "failed");
	assert.equal(row.acceptanceUnknown, false);
	assert.equal(w.smtpCalls.length, 0);
	assert.equal(w.marks.length, 1);
	assert.match(w.marks[0].error, /Attachment not allowed/);
});

await test("refus du serveur (554) : failed certain, Reessayer sans confirmation", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: false, error: "554 5.7.1 rejected", ambiguous: false }) });
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "failed");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "failed");
	assert.equal(row.acceptanceUnknown, false);
	assert.equal(outboxActionsOf(row).confirmRetry, false);
	assert.equal(w.msgs.length, 0);
	assert.match(w.marks[0].error, /554/);
});

await test("refus sans cause : echec quand meme (b77c7d8d)", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: false }) });
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "failed");
	assert.equal(w.msgs.length, 0);
	assert.equal(w.marks.length, 1);
});

await test("issue inconnue (coupure apres DATA) : interrompu, Reessayer exige la confirmation", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: false, error: "Connection closed", ambiguous: true }) });
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "interrupted");
	const row = w.ledger.get("row-1")!;
	assert.equal(row.status, "failed");
	assert.equal(row.acceptanceUnknown, true);
	assert.equal(outboxActionsOf(row).confirmRetry, true);
	assert.equal(w.marks.length, 1);
});

await test("mailer qui leve : interrompu (on ne sait pas ou il s'est arrete)", async () => {
	const w = world([ledgerRow()], {
		smtp: () => {
			throw new Error("socket hang up");
		},
	});
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "interrupted");
	assert.equal(w.ledger.get("row-1")!.acceptanceUnknown, true);
});

await test("250 mais UPDATE « accepte » en echec : la ligne reste sending, jamais failed", async () => {
	const w = world([ledgerRow()]);
	w.failAccept = true;
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "unrecorded");
	assert.equal(w.ledger.get("row-1")!.status, "sending");
	assert.deepEqual(w.marks, []);
	assert.equal(w.msgs.length, 0);
});

await test("acceptation tardive apres un balayage « interrompu » : la ligne passe a sent", async () => {
	const w = world([ledgerRow()], {
		smtp: (messageId) => {
			// Le balayage est passe pendant le SMTP (plus de 10 min) : interrompu.
			Object.assign(w.ledger.get("row-1")!, { status: "failed", acceptanceUnknown: true });
			return { success: true, MessageId: messageId };
		},
	});
	const res = await runSend("row-1", w.deps);
	assert.equal(res.outcome, "sent");
	assert.equal(w.ledger.get("row-1")!.status, "sent");
});

await test("Message-ID rendu different par le fournisseur (SES) : il remplace celui de la ligne", async () => {
	const w = world([ledgerRow()], { smtp: () => ({ success: true, MessageId: "<0100abc@eu-west-1.amazonses.com>" }) });
	await runSend("row-1", w.deps);
	assert.equal(w.ledger.get("row-1")!.messageId, "<0100abc@eu-west-1.amazonses.com>");
	assert.equal(w.msgs[0].messageId, "<0100abc@eu-west-1.amazonses.com>");
});

await test("ligne d'avant le ledger (message_id NULL) : Message-ID genere avant le SMTP", async () => {
	const w = world([ledgerRow({ messageId: null })]);
	await runSend("row-1", w.deps);
	assert.deepEqual(w.smtpCalls, ["<gen-1@ss2i.example>"]);
	assert.equal(w.ledger.get("row-1")!.messageId, "<gen-1@ss2i.example>");
});

await test("balayage : sending de plus de 10 min -> interrompu sans renvoi, marque retiree", async () => {
	const old = new Date(NOW.getTime() - 11 * 60_000);
	const recent = new Date(NOW.getTime() - 2 * 60_000);
	const w = world([
		ledgerRow({ id: "stale", status: "sending", updatedAt: old }),
		ledgerRow({ id: "fresh", status: "sending", updatedAt: recent }),
	]);
	const res = await sweepLedger(w.deps, NOW);
	assert.deepEqual(res.interrupted, ["stale"]);
	assert.equal(w.ledger.get("stale")!.status, "failed");
	assert.equal(w.ledger.get("stale")!.acceptanceUnknown, true);
	assert.equal(w.ledger.get("fresh")!.status, "sending");
	assert.equal(w.smtpCalls.length, 0);
	assert.deepEqual(w.marks.map((m) => m.imapDraftId), ["imap-1"]);
});

await test("balayage : accepte depuis plus de 2 min sans copie Envoyes -> finalise une fois", async () => {
	const old = new Date(NOW.getTime() - 3 * 60_000);
	const rendered = { mailboxId: "mb-sent", subject: "Objet" };
	const w = world([
		ledgerRow({ id: "a", status: "sent", acceptedAt: old, rendered }),
		ledgerRow({ id: "b", status: "sent", acceptedAt: NOW, rendered, messageId: "<u-2@x>" }),
		ledgerRow({ id: "c", status: "sent", acceptedAt: old, rendered, deliveryState: "queued", messageId: "<u-3@x>" }),
	]);
	const res = await sweepLedger(w.deps, NOW);
	assert.deepEqual(res.finalized, ["a"]);
	assert.equal(w.msgs.length, 1);
	await sweepLedger(w.deps, NOW);
	assert.equal(w.msgs.length, 1);
});

await test("job herite send-and-reconcile : une seule ligne ledger, meme rejoue", async () => {
	const inserted: any[] = [];
	const io = {
		findByLegacyKey: async (key: string) => inserted.find((r) => r.payload.__legacyJobKey === key) ?? null,
		insertRow: async (v: any) => {
			const r = { id: `row-${inserted.length + 1}`, ...v };
			inserted.push(r);
			return r;
		},
		newMessageId: () => "<gen-9@x>",
	};
	const job = { id: "42", timestamp: 1_700_000_000_000, data: { sentMailboxId: "mb-sent", identityId: "ident-1", subject: "s" } };
	const first = await legacyLedgerRow(job, { identityId: "ident-1", fromAddress: "a@x" }, io, NOW);
	const again = await legacyLedgerRow(job, { identityId: "ident-1", fromAddress: "a@x" }, io, NOW);
	assert.equal(first, again);
	assert.equal(inserted.length, 1);
	assert.equal(inserted[0].origin, "direct");
	assert.equal(inserted[0].status, "scheduled");
	assert.equal(inserted[0].mailboxId, "mb-sent", "mailboxId = sentMailboxId a defaut");
	assert.equal(inserted[0].payload.__legacyJobKey, "42:1700000000000");
	assert.equal(inserted[0].messageId, "<gen-9@x>");
});

if (failures) {
	console.error(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
})();
