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
	settleActionOf,
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

// Marque vers une ligne ledger terminee (nettoyage apres envoi, restauration ou retrait de marque
// en echec) : le brouillon n'est plus verrouille, Annuler et le balayage le remettent d'aplomb.
test("pendingSendAlive : une marque vers une ligne terminee ou absente ne verrouille plus", () => {
	const now = Date.parse("2026-11-13T10:00:00.000Z");
	const mark = { jobId: "5c1e0f6e-1111-4222-8333-444455556666", sendAt: new Date(now - 3600_000).toISOString() };
	const at = new Date(now - 60_000);
	// Ligne non lue (appelant synchrone) : comportement d'avant, vivante.
	assert.equal(pendingSendAlive(mark, now), true);
	assert.equal(pendingSendAlive(mark, now, { status: "scheduled" }), true);
	assert.equal(pendingSendAlive(mark, now, { status: "sending" }), true);
	// Acceptee, copie Envoyes pas encore faite : le nettoyage du brouillon suit la finalisation.
	assert.equal(pendingSendAlive(mark, now, { status: "sent", acceptedAt: at, sentRowId: null }), true);
	assert.equal(pendingSendAlive(mark, now, { status: "sent", acceptedAt: at, sentRowId: "m-1" }), false);
	assert.equal(pendingSendAlive(mark, now, { status: "failed" }), false);
	assert.equal(pendingSendAlive(mark, now, { status: "canceled" }), false);
	assert.equal(pendingSendAlive(mark, now, { status: "sent", acceptedAt: at, sentRowId: "m-1", dismissedAt: at }), false);
	assert.equal(pendingSendAlive(mark, now, null), false);
	// Un decompte « undo-send-* » ne depend pas de la ligne.
	const countdown = { jobId: "undo-send-abc", sendAt: new Date(now - 30_000).toISOString() };
	assert.equal(pendingSendAlive(countdown, now, null), true);
});

test("settleActionOf : brouillon supprime si l'envoi a sa copie Envoyes, marque retiree sinon", () => {
	const at = new Date("2026-11-13T09:00:00.000Z");
	assert.equal(settleActionOf({ status: "scheduled" }), null);
	assert.equal(settleActionOf({ status: "sending" }), null);
	assert.equal(settleActionOf({ status: "sent", acceptedAt: at, sentRowId: null }), null);
	assert.equal(settleActionOf({ status: "sent", acceptedAt: at, sentRowId: "m-1" }), "delete");
	assert.equal(settleActionOf({ status: "failed" }), "unlock");
	assert.equal(settleActionOf({ status: "canceled" }), "unlock");
	// Ecartee (rejet signale puis « Ecarter ») : le contenu reste au brouillon.
	assert.equal(settleActionOf({ status: "sent", acceptedAt: at, sentRowId: "m-1", dismissedAt: at }), "unlock");
	assert.equal(settleActionOf({ status: "failed", dismissedAt: at }), "unlock");
	// Ancienne ligne « sent » d'avant le ledger (jamais acceptee ni finalisee) : la marque seule part.
	assert.equal(settleActionOf({ status: "sent" }), "unlock");
});

test("message de refus de la garde", () => {
	assert.equal(DRAFT_PENDING_ERROR, "This draft is scheduled; cancel the scheduled send first");
});

if (failures) {
	console.error(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
