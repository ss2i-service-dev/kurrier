// Etat d'envoi d'un brouillon (packages/common/src/draft-send.ts) : pendingSend conserve
// par une mise a jour d'autosave, sendError efface par une modification. Aucune base.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/draft-send.ts
import assert from "node:assert/strict";
import {
	DRAFT_PENDING_ERROR,
	draftSendStateOf,
	mergeDraftMeta,
	pendingSendAlive,
	type DraftSendFields,
} from "../../../packages/common/src/draft-send";

type Meta = DraftSendFields & { draftId: string; revision: number; subject?: string };

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

const pendingSend = { jobId: "undo-send-1", sendAt: "2026-11-02T09:00:30.000Z" };
const sendError = { message: "SMTP refused", at: "2026-11-02T09:01:00.000Z" };

test("autosave conserve pendingSend", () => {
	const prev: Meta = { draftId: "d", revision: 3, pendingSend };
	const merged = mergeDraftMeta<Meta>(prev, { draftId: "d", revision: 4 });
	assert.deepEqual(merged.pendingSend, pendingSend);
	assert.equal(merged.revision, 4);
});

test("pendingSend efface (annulation) : l'autosave suivant ne le recree pas", () => {
	const prev: Meta = { draftId: "d", revision: 4 };
	const merged = mergeDraftMeta<Meta>(prev, { draftId: "d", revision: 5, pendingSend });
	assert.equal(merged.pendingSend, undefined);
});

test("une modification efface sendError", () => {
	const prev: Meta = { draftId: "d", revision: 2, sendError };
	const merged = mergeDraftMeta<Meta>(prev, { draftId: "d", revision: 3 });
	assert.equal(merged.sendError, undefined);
});

test("premiere ecriture sans meta precedente", () => {
	const merged = mergeDraftMeta<Meta>(null, { draftId: "d", revision: 1 });
	assert.deepEqual(draftSendStateOf(merged), { pendingSend: null, sendError: null });
});

test("draftSendStateOf lit les deux marques", () => {
	assert.deepEqual(draftSendStateOf({ pendingSend, sendError }), { pendingSend, sendError });
	assert.deepEqual(draftSendStateOf(null), { pendingSend: null, sendError: null });
});

// Garde : un brouillon dont l'envoi est en attente ne se modifie ni ne se supprime en douce.
test("pendingSendAlive : decompte en cours, programme, perime", () => {
	const now = Date.parse("2026-11-12T10:00:00.000Z");
	const countdown = (offsetMs: number) => ({ jobId: "undo-send-abc", sendAt: new Date(now + offsetMs).toISOString() });
	assert.equal(pendingSendAlive(null, now), false);
	assert.equal(pendingSendAlive(undefined, now), false);
	assert.equal(pendingSendAlive(countdown(30_000), now), true);
	assert.equal(pendingSendAlive(countdown(-2 * 60_000), now), true);
	// Decompte sans resultat depuis plus de 3 minutes : etat inconnu, ne bloque plus.
	assert.equal(pendingSendAlive(countdown(-4 * 60_000), now), false);
	// Envoi programme (jobId = ligne draft_messages) : vivant tant que la marque existe,
	// meme si l'heure est depassee (worker arrete) : seule l'annulation ou l'envoi l'efface.
	const scheduled = (offsetMs: number) => ({ jobId: "5c1e0f6e-1111-4222-8333-444455556666", sendAt: new Date(now + offsetMs).toISOString() });
	assert.equal(pendingSendAlive(scheduled(24 * 3600_000), now), true);
	assert.equal(pendingSendAlive(scheduled(-3600_000), now), true);
	assert.equal(pendingSendAlive({ jobId: "x", sendAt: "pas une date" }, now), false);
});

test("message de refus de la garde", () => {
	assert.equal(DRAFT_PENDING_ERROR, "This draft is scheduled; cancel the scheduled send first");
});

if (failures) {
	console.error(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
