// Boite d'envoi (OI 10519, Samuel le 13/11 : « les mails en file d'attente qui ne sont pas
// effectivement partis, il faut me les mettre dans un truc en cours d'envoi [...] La boîte
// d'envoi. »). Une ligne draft_messages par envoi (ledger) ; l'etat affiche, la visibilite, le
// compteur et les actions sont calcules par une seule fonction pure. Migration ss2i_009 lue en
// texte (pas de Postgres dans les tests).
// Depuis la racine :
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/outbox.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isOutboxVisible,
	outboxActionsOf,
	outboxCountOf,
	sendStateOf,
	type LedgerStateRow,
} from "../../../packages/common/src/outbox-state";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const row = (o: Partial<LedgerStateRow>): LedgerStateRow => ({
	status: "scheduled",
	deliveryState: "none",
	acceptanceUnknown: false,
	acceptedAt: null,
	dismissedAt: null,
	...o,
});

test("sendStateOf : table de verite du plan", () => {
	const cases: [Partial<LedgerStateRow>, string | null][] = [
		[{ status: "scheduled" }, "pending"],
		[{ status: "sending" }, "sending"],
		[{ status: "failed" }, "failed"],
		[{ status: "failed", acceptanceUnknown: true }, "interrupted"],
		[{ status: "canceled" }, "canceled"],
		[{ status: "sent", deliveryState: "none" }, "delivered"],
		[{ status: "sent", deliveryState: "delivered" }, "delivered"],
		[{ status: "sent", deliveryState: "queued" }, "queued"],
		[{ status: "sent", deliveryState: "canceling" }, "canceling"],
		[{ status: "sent", deliveryState: "rejected" }, "rejected"],
		[{ status: "sent", deliveryState: "unknown" }, "unknown"],
		[{ status: "sent", deliveryState: null }, "delivered"],
		[{ status: "draft" }, null],
	];
	for (const [o, want] of cases) assert.equal(sendStateOf(row(o)), want, JSON.stringify(o));
});

test("visibilite : en cours toujours, echecs tant qu'ils ne sont pas ecartes, jamais remis ni annules", () => {
	const visible = (o: Partial<LedgerStateRow>) => isOutboxVisible(row(o));
	assert.equal(visible({ status: "scheduled" }), true);
	assert.equal(visible({ status: "sending" }), true);
	assert.equal(visible({ status: "sent", deliveryState: "queued" }), true);
	assert.equal(visible({ status: "sent", deliveryState: "canceling" }), true);
	assert.equal(visible({ status: "sent", deliveryState: "unknown" }), true);
	assert.equal(visible({ status: "failed" }), true);
	assert.equal(visible({ status: "failed", acceptanceUnknown: true }), true);
	assert.equal(visible({ status: "sent", deliveryState: "rejected" }), true);
	assert.equal(visible({ status: "failed", dismissedAt: new Date() }), false);
	assert.equal(visible({ status: "failed", acceptanceUnknown: true, dismissedAt: "2026-11-13T08:00:00Z" }), false);
	assert.equal(visible({ status: "sent", deliveryState: "rejected", dismissedAt: new Date() }), false);
	assert.equal(visible({ status: "sent" }), false);
	assert.equal(visible({ status: "canceled" }), false);
	assert.equal(visible({ status: "draft" }), false);
});

test("compteur : lignes visibles, alerte hors attente, envoi et en file", () => {
	assert.deepEqual(outboxCountOf([]), { total: 0, alert: 0 });
	assert.deepEqual(
		outboxCountOf([
			row({ status: "scheduled" }),
			row({ status: "sending" }),
			row({ status: "sent", deliveryState: "queued" }),
			row({ status: "sent" }),
			row({ status: "canceled" }),
			row({ status: "failed", dismissedAt: new Date() }),
		]),
		{ total: 3, alert: 0 },
	);
	assert.deepEqual(
		outboxCountOf([
			row({ status: "scheduled" }),
			row({ status: "failed" }),
			row({ status: "failed", acceptanceUnknown: true }),
			row({ status: "sent", deliveryState: "unknown" }),
		]),
		{ total: 4, alert: 3 },
	);
});

test("actions : annuler et envoyer maintenant en attente seulement", () => {
	assert.deepEqual(outboxActionsOf(row({ status: "scheduled" })), {
		cancel: true,
		sendNow: true,
		retry: false,
		confirmRetry: false,
		dismiss: false,
	});
	for (const o of [{ status: "sending" }, { status: "sent" }, { status: "canceled" }] as const) {
		const a = outboxActionsOf(row(o));
		assert.equal(a.cancel || a.sendNow || a.retry || a.dismiss, false, o.status);
	}
});

test("actions : reessayer un echec certain sans confirmation, un envoi interrompu avec", () => {
	const failed = outboxActionsOf(row({ status: "failed" }));
	assert.equal(failed.retry, true);
	assert.equal(failed.confirmRetry, false);
	assert.equal(failed.dismiss, true);
	const interrupted = outboxActionsOf(row({ status: "failed", acceptanceUnknown: true }));
	assert.equal(interrupted.retry, true);
	assert.equal(interrupted.confirmRetry, true);
	assert.equal(interrupted.dismiss, true);
});

test("actions : jamais reessayer un envoi accepte par le serveur", () => {
	const a = outboxActionsOf(row({ status: "failed", acceptedAt: new Date() }));
	assert.equal(a.retry, false);
	const rejected = outboxActionsOf(row({ status: "sent", deliveryState: "rejected", acceptedAt: new Date() }));
	assert.equal(rejected.retry, false);
	assert.equal(rejected.dismiss, true);
});

const root = join(__dirname, "../../..");
const sqlText = readFileSync(join(root, "db/init/migrations/ss2i_009_migration.sql"), "utf8");
const code = sqlText.replace(/--[^\n]*/g, "");

test("migration ss2i_009 : colonnes du ledger, rejouable", () => {
	for (const col of [
		"origin",
		"message_id",
		"accepted_at",
		"acceptance_unknown",
		"smtp_response",
		"delivery_state",
		"queue_ref",
		"last_error",
		"next_attempt_at",
		"delivery_checked_at",
		"delivered_at",
		"dismissed_at",
		"rendered",
		"sent_row_id",
	]) {
		assert.match(code, new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\b`, "i"), col);
	}
	assert.match(code, /origin\s+text\s+NOT NULL\s+DEFAULT\s+'scheduled'/i);
	assert.match(code, /delivery_state\s+text\s+NOT NULL\s+DEFAULT\s+'none'/i);
	assert.match(code, /acceptance_unknown\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i);
	assert.doesNotMatch(code, /REFERENCES/i, "sent_row_id sans FK");
	assert.doesNotMatch(code, /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i, "index rejouables");
});

test("migration ss2i_009 : index unique partiel sur (identity_id, message_id)", () => {
	assert.match(
		code,
		/CREATE UNIQUE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(public\.)?draft_messages\s*\(\s*identity_id\s*,\s*message_id\s*\)\s*WHERE\s+message_id IS NOT NULL/i,
	);
	assert.match(
		code,
		/CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(public\.)?draft_messages\s*\(\s*identity_id\s*,\s*status\s*,\s*delivery_state\s*\)/i,
	);
});

test("migration ss2i_009 : seuls les echecs d'avant le ledger sont ecartes, meme rejouee", () => {
	const update = code.match(/UPDATE\s+(public\.)?draft_messages[\s\S]*?;/i)?.[0] ?? "";
	assert.match(update, /SET\s+dismissed_at\s*=\s*now\(\)/i);
	assert.match(update, /status\s*=\s*'failed'/i);
	assert.match(update, /message_id IS NULL/i, "un echec du ledger (message_id pose) reste visible");
	assert.match(update, /dismissed_at IS NULL/i);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
