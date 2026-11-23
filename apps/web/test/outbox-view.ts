// Outbox, interface: state labels, place of the entry in the sidebar (between Drafts and Sent),
// counter (visible sends, never unread counts, red on alert), refresh while a send moves, and
// only the drafts whose send is in the Outbox left out of Drafts.
// From the root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/outbox-view.ts
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

const STATES = ["pending", "sending", "failed", "interrupted", "canceled", "delivered", "queued", "canceling", "rejected", "unknown"] as const;

test("every state has a label, all distinct", () => {
	const labels = STATES.map((s) => outboxStateLabel(s));
	for (const l of labels) assert.ok(l.length > 0);
	assert.equal(new Set(labels).size, STATES.length, labels.join(" | "));
	assert.match(outboxStateLabel("interrupted"), /may have been sent/);
	assert.match(outboxStateLabel("failed"), /Not sent/);
	assert.match(outboxStateLabel("sending"), /Sending/);
});

test("Outbox entry right after Drafts, otherwise before Sent, otherwise at the end", () => {
	assert.equal(outboxSlot(["inbox", "drafts", "sent", "archive"]), 2);
	assert.equal(outboxSlot(["inbox", "sent", "archive"]), 1);
	assert.equal(outboxSlot(["inbox", "archive"]), 2);
});

test("counter: number of visible sends, nothing at zero, alert when a send failed", () => {
	assert.equal(outboxSidebarCount(undefined), null);
	assert.equal(outboxSidebarCount({ total: 0, alert: 0 }), null);
	assert.deepEqual(outboxSidebarCount({ total: 3, alert: 0 }), { n: 3, alert: false });
	assert.deepEqual(outboxSidebarCount({ total: 3, alert: 1 }), { n: 3, alert: true });
	// the "outbox" folder never gets an unread counter
	assert.equal(showsSidebarCount("outbox"), false);
});

test("refresh: fast during a send or a countdown, wake-up before a scheduled send, nothing otherwise", () => {
	const now = Date.parse("2026-11-13T08:00:00Z");
	const at = (ms: number) => new Date(now + ms).toISOString();
	assert.deepEqual(outboxRefreshOf([], now), { poll: false, wakeAt: null });
	assert.equal(outboxRefreshOf([{ busy: 1, pendingAt: [] }], now).poll, true, "send in progress");
	assert.equal(outboxRefreshOf([{ busy: 0, pendingAt: [at(10_000)] }], now).poll, true, "countdown");
	// scheduled tomorrow: no polling, one wake-up 2 minutes before
	const tomorrow = outboxRefreshOf([{ busy: 0, pendingAt: [at(86_400_000)] }], now);
	assert.equal(tomorrow.poll, false);
	assert.equal(tomorrow.wakeAt, now + 86_400_000 - 120_000);
	// late by more than 3 minutes (job gone): polling stops
	assert.equal(outboxRefreshOf([{ busy: 0, pendingAt: [at(-4 * 60_000)] }], now).poll, false);
});

test("Drafts hides only the drafts whose send is in the Outbox", () => {
	const ids = new Set(["row-1"]);
	const mark = (jobId: string) => ({ pendingSend: { jobId, sendAt: "x" }, sendError: null });
	assert.equal(inOutbox(mark("row-1"), ids), true);
	// stale mark (row canceled, sent, failed restore) or old undo-send-* mark: the draft stays
	// visible with its badge, never lost between two lists
	assert.equal(inOutbox(mark("row-2"), ids), false);
	assert.equal(inOutbox(mark("undo-send-9"), ids), false);
	assert.equal(inOutbox({ pendingSend: null, sendError: { message: "boom", at: "x" } }, ids), false);
	assert.equal(inOutbox(null, ids), false);
});

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const MAIL = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]";

test("both sidebars have the Outbox entry, fed by fetchOutboxCounts", () => {
	for (const p of ["components/dashboard/identity-mailboxes-list.tsx", "components/k/sidebar-nav.tsx"]) {
		const s = src(p);
		assert.match(s, /\/outbox`/, p);
		assert.match(s, /outboxSlot\(/, p);
		assert.match(s, /outboxSidebarCount\(/, p);
		assert.doesNotMatch(s, /\/scheduled`/, `${p}: no Scheduled link anymore`);
	}
	for (const p of ["components/dashboard/workspaces/identity-mailboxes-list-wrapper.tsx", "components/k/sidebar-nav-wrapper.tsx"]) {
		assert.match(src(p), /fetchOutboxCounts\(\)/, p);
	}
});

test("/outbox page (fetchOutbox); /scheduled redirects to it", () => {
	assert.match(src(`${MAIL}/outbox/page.tsx`), /fetchOutbox\(/);
	assert.match(src(`${MAIL}/scheduled/page.tsx`), /redirect\(`[^`]*\/outbox`\)/);
	const list = src("components/mailbox/default/outbox-list.tsx");
	for (const a of ["cancelPendingSend", "sendPendingNow", "retryOutboxSend", "dismissOutboxSend", "formatScheduledWhen"]) {
		assert.match(list, new RegExp(`${a}\\(`), a);
	}
	// times follow the "24-hour time" option
	assert.match(list, /useHour24\(\)/);
	assert.match(list, /sendLabel\([^)]*hour24\)/);
	assert.match(list, /formatScheduledWhen\([^;]*hour24\)/);
});

test("Drafts has no Outbox section anymore: sends in the Outbox leave the list", () => {
	for (const p of ["components/mailbox/default/webmail-list.tsx", "components/k/thread-list.tsx"]) {
		const s = src(p);
		assert.match(s, /inOutbox\(/, p);
		assert.doesNotMatch(s, /Outbox \(\{sending\.length\}\)|Pending sends \(\{sending\.length\}\)/, p);
	}
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
