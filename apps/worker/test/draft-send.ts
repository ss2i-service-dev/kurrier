// Etat d'envoi d'un brouillon (packages/common/src/draft-send.ts) : pendingSend conserve
// par une mise a jour d'autosave, sendError efface par une modification. Aucune base.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/draft-send.ts
import assert from "node:assert/strict";
import {
	draftSendStateOf,
	mergeDraftMeta,
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

if (failures) {
	console.error(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
