// Envoi programme (packages/common/src/schedule-send.ts) : le job BullMQ est construit au meme
// endroit pour l'editeur web, le MCP (send_draft + send_at) et la reprise au demarrage du
// worker ; le brouillon IMAP se retrouve depuis un job « send-and-reconcile » comme depuis un
// job « send-scheduled-draft ». Aucune base, aucun Redis.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/scheduled-send.ts
import assert from "node:assert/strict";
import { isScheduledMark } from "../../../packages/common/src/draft-send";
import {
	SCHEDULED_JOB,
	imapDraftIdOfJob,
	rehydrateActionOf,
	scheduledJobOf,
	scheduledPendingSend,
} from "../../../packages/common/src/schedule-send";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const NOW = Date.parse("2026-11-12T09:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
	id: "row-1",
	identityId: "ident-1",
	scheduledAt: new Date("2026-11-12T11:00:00Z"),
	payload: { draftMessageId: "imap-draft-1", identityId: "ident-1" },
	...over,
});

test("job programme : jobId = ligne, delai jusqu'a l'heure, identite et brouillon IMAP dans les donnees", () => {
	const job = scheduledJobOf(row(), NOW);
	assert.equal(job.name, SCHEDULED_JOB);
	assert.equal(job.name, "send-scheduled-draft");
	assert.deepEqual(job.data, { draftMessageId: "row-1", identityId: "ident-1", imapDraftId: "imap-draft-1" });
	assert.equal(job.opts.jobId, "row-1");
	assert.equal(job.opts.delay, 2 * 3600_000);
});

test("reprise : une heure deja passee donne un delai de 0, jamais negatif", () => {
	assert.equal(scheduledJobOf(row({ scheduledAt: new Date("2026-11-12T08:00:00Z") }), NOW).opts.delay, 0);
});

test("sans brouillon IMAP (envoi programme depuis le MCP ou brouillon supprime) : imapDraftId null", () => {
	const job = scheduledJobOf(row({ payload: {} }), NOW);
	assert.equal(job.data.imapDraftId, null);
});

test("marque pendingSend du brouillon : jobId de la ligne, heure ISO", () => {
	assert.deepEqual(scheduledPendingSend(row()), { jobId: "row-1", sendAt: "2026-11-12T11:00:00.000Z" });
});

test("brouillon IMAP d'un job : draftMessageId pour un envoi differe, imapDraftId pour un programme", () => {
	assert.equal(imapDraftIdOfJob("send-and-reconcile", { draftMessageId: "d1" }), "d1");
	assert.equal(imapDraftIdOfJob("send-scheduled-draft", { draftMessageId: "row-1", imapDraftId: "d2" }), "d2");
	assert.equal(imapDraftIdOfJob("send-scheduled-draft", { draftMessageId: "row-1", imapDraftId: null }), "");
	assert.equal(imapDraftIdOfJob("send-and-reconcile", {}), "");
	assert.equal(imapDraftIdOfJob("autre", { draftMessageId: "x" }), "");
});

// Reprise au demarrage : que faire d'une ligne « scheduled » selon l'etat de son job.
test("rehydrateActionOf : ajouter, garder, echouer, ne jamais rejouer", () => {
	assert.equal(rehydrateActionOf(null), "add");
	for (const s of ["delayed", "waiting", "active", "prioritized", "paused", "waiting-children"]) {
		assert.equal(rehydrateActionOf(s), "keep", s);
	}
	// Job en echec alors que la ligne est restee « scheduled » : echec de la ligne, jamais relance.
	assert.equal(rehydrateActionOf("failed"), "fail");
	// Job termine, ligne encore « scheduled » : anomalie, signalee, pas de second envoi.
	assert.equal(rehydrateActionOf("completed"), "skip");
	assert.equal(rehydrateActionOf("unknown"), "keep");
});

test("isScheduledMark : jobId d'une ligne programmee, pas d'un decompte undo-send-", () => {
	assert.equal(isScheduledMark({ jobId: "5c1e0f6e-1111-4222-8333-444455556666", sendAt: "x" }), true);
	assert.equal(isScheduledMark({ jobId: "undo-send-5c1e0f6e", sendAt: "x" }), false);
	assert.equal(isScheduledMark(null), false);
});

if (failures) {
	console.error(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
