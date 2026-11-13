// Boite d'envoi (OI 10519), interface : libelles des etats (fr et en), place de l'entree dans la
// barre laterale (entre Drafts et Sent), compteur (envois visibles, jamais de non lus, rouge sur
// alerte), actualisation tant qu'un envoi bouge, et retrait de Drafts des seuls brouillons dont
// l'envoi est dans la Boite d'envoi (Samuel le 13/11 : « quand ils sont en train de s'envoyer, ou
// en attente d'envoi [...] il faut que ça arrive là-dedans. La boîte d'envoi. »).
// Lance au build avec les autres apps/web/test/*.ts. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/outbox-view.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inOutbox, outboxRefreshOf, outboxSlot, outboxStateLabel } from "../lib/outbox-view";
import { outboxSidebarCount, showsSidebarCount } from "../lib/folder-unread-counts";

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

const en = (e: string) => e;
const fr = (_e: string, f: string) => f;
const STATES = ["pending", "sending", "failed", "interrupted", "canceled", "delivered", "queued", "canceling", "rejected", "unknown"] as const;

test("chaque etat a un libelle francais et anglais, tous distincts", () => {
	for (const k of [en, fr]) {
		const labels = STATES.map((s) => outboxStateLabel(s, k));
		for (const l of labels) assert.ok(l.length > 0);
		assert.equal(new Set(labels).size, STATES.length, labels.join(" | "));
	}
	assert.match(outboxStateLabel("interrupted", fr), /peut-être/);
	assert.match(outboxStateLabel("failed", fr), /Non envoyé/);
	assert.match(outboxStateLabel("sending", en), /Sending/);
});

test("entree Boite d'envoi juste apres Drafts, sinon avant Sent, sinon en fin", () => {
	assert.equal(outboxSlot(["inbox", "drafts", "sent", "archive"]), 2);
	assert.equal(outboxSlot(["inbox", "sent", "archive"]), 1);
	assert.equal(outboxSlot(["inbox", "archive"]), 2);
});

test("compteur : nombre d'envois visibles, rien a zero, alerte si un envoi est en echec", () => {
	assert.equal(outboxSidebarCount(undefined), null);
	assert.equal(outboxSidebarCount({ total: 0, alert: 0 }), null);
	assert.deepEqual(outboxSidebarCount({ total: 3, alert: 0 }), { n: 3, alert: false });
	assert.deepEqual(outboxSidebarCount({ total: 3, alert: 1 }), { n: 3, alert: true });
	// le dossier « outbox » reste sans compteur de non lus
	assert.equal(showsSidebarCount("outbox"), false);
});

test("actualisation : rapide pendant un envoi ou un decompte, reveil avant un envoi programme, rien sinon", () => {
	const now = Date.parse("2026-11-13T08:00:00Z");
	const at = (ms: number) => new Date(now + ms).toISOString();
	assert.deepEqual(outboxRefreshOf([], now), { poll: false, wakeAt: null });
	assert.equal(outboxRefreshOf([{ busy: 1, pendingAt: [] }], now).poll, true, "envoi en cours");
	assert.equal(outboxRefreshOf([{ busy: 0, pendingAt: [at(10_000)] }], now).poll, true, "decompte");
	// programme demain : pas de sondage, un reveil 2 minutes avant
	const tomorrow = outboxRefreshOf([{ busy: 0, pendingAt: [at(86_400_000)] }], now);
	assert.equal(tomorrow.poll, false);
	assert.equal(tomorrow.wakeAt, now + 86_400_000 - 120_000);
	// en retard depuis plus de 3 minutes (job disparu) : on cesse de sonder
	assert.equal(outboxRefreshOf([{ busy: 0, pendingAt: [at(-4 * 60_000)] }], now).poll, false);
});

test("Drafts ne cache que les brouillons dont l'envoi est dans la Boite d'envoi", () => {
	const ids = new Set(["row-1"]);
	const mark = (jobId: string) => ({ pendingSend: { jobId, sendAt: "x" }, sendError: null });
	assert.equal(inOutbox(mark("row-1"), ids), true);
	// marque perimee (ligne annulee, partie, restauration en echec) ou ancienne marque undo-send-* :
	// le brouillon reste visible avec son badge, jamais perdu entre deux listes
	assert.equal(inOutbox(mark("row-2"), ids), false);
	assert.equal(inOutbox(mark("undo-send-9"), ids), false);
	assert.equal(inOutbox({ pendingSend: null, sendError: { message: "boom", at: "x" } }, ids), false);
	assert.equal(inOutbox(null, ids), false);
});

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const MAIL = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]";

test("les deux barres laterales ont l'entree Boite d'envoi, nourrie par fetchOutboxCounts", () => {
	for (const p of ["components/dashboard/identity-mailboxes-list.tsx", "components/k/sidebar-nav.tsx"]) {
		const s = src(p);
		assert.match(s, /\/outbox`/, p);
		assert.match(s, /outboxSlot\(/, p);
		assert.match(s, /outboxSidebarCount\(/, p);
		assert.doesNotMatch(s, /\/scheduled`/, `${p} : plus de lien Scheduled`);
	}
	for (const p of ["components/dashboard/workspaces/identity-mailboxes-list-wrapper.tsx", "components/k/sidebar-nav-wrapper.tsx"]) {
		assert.match(src(p), /fetchOutboxCounts\(\)/, p);
	}
});

test("page /outbox (fetchOutbox) ; /scheduled y redirige", () => {
	assert.match(src(`${MAIL}/outbox/page.tsx`), /fetchOutbox\(/);
	assert.match(src(`${MAIL}/scheduled/page.tsx`), /redirect\(`[^`]*\/outbox`\)/);
	const list = src("components/mailbox/default/outbox-list.tsx");
	for (const a of ["cancelPendingSend", "sendPendingNow", "retryOutboxSend", "dismissOutboxSend", "formatScheduledWhen"]) {
		assert.match(list, new RegExp(`${a}\\(`), a);
	}
});

test("Drafts n'a plus de section Outbox : les envois de la Boite d'envoi sortent de la liste", () => {
	for (const p of ["components/mailbox/default/webmail-list.tsx", "components/k/thread-list.tsx"]) {
		const s = src(p);
		assert.match(s, /inOutbox\(/, p);
		assert.doesNotMatch(s, /Outbox \(\{sending\.length\}\)|Envois en attente \(\{sending\.length\}\)/, p);
	}
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
