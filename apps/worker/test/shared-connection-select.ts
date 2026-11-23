// Shared IMAP command connection: opening a folder must never switch the selection back while
// another process holds the lock of a folder.
// Incident: during the Drafts sync (lock held, UID range 1:17 computed on Drafts), the folder
// discovery did a mailboxOpen without the lock; the FETCH went to INBOX, the INBOX messages
// carrying those UIDs were taken for moves to Drafts and each carried its whole thread away.
// No database. From the root: node_modules/.bin/tsx apps/worker/test/shared-connection-select.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openMailboxLocked, selectedIs } from "../lib/imap/imap-open-locked";

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
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

// Fake ImapFlow: exclusive lock queue, like ImapFlow (getMailboxLock waits for the release of the
// previous lock and selects the requested folder).
class FakeClient {
	mailbox: { path: string; uidNext: number; uidValidity: number } | false = false;
	private queue: Promise<void> = Promise.resolve();
	uidNext: Record<string, number> = { INBOX: 10020, Drafts: 18, Archive: 58 };
	async mailboxOpen(path: string) {
		this.mailbox = { path, uidNext: this.uidNext[path] ?? 1, uidValidity: 1 };
		return this.mailbox;
	}
	async getMailboxLock(path: string) {
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const previous = this.queue;
		this.queue = previous.then(() => held);
		await previous;
		if (!this.mailbox || this.mailbox.path !== path) await this.mailboxOpen(path);
		return { release };
	}
}
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
	await test("openMailboxLocked waits for the end of the Drafts pass before opening another folder", async () => {
		const client = new FakeClient();
		const lock = await client.getMailboxLock("Drafts");
		const opening = openMailboxLocked(client as any, "Archive");
		await tick();
		assert.ok(selectedIs(client as any, "Drafts"), "the selection stayed on Drafts during the pass");
		lock.release();
		const box = await opening;
		assert.equal(box.path, "Archive");
		assert.equal(box.uidNext, 58);
	});

	await test("a mailboxOpen without the lock is detected by selectedIs (syncMailbox guard)", async () => {
		const client = new FakeClient();
		const lock = await client.getMailboxLock("Drafts");
		await client.mailboxOpen("INBOX"); // the old behavior of the discovery
		assert.equal(selectedIs(client as any, "Drafts"), false);
		lock.release();
	});

	await test("no unlocked mailboxOpen left in folder discovery and folder creation", () => {
		for (const f of [
			"lib/imap/backfill/discover/discover-mailboxes.ts",
			"lib/imap/backfill/discover/discover-trash.ts",
			"lib/imap/backfill/discover/discover-archive.ts",
			"lib/imap/imap-new-folder.ts",
		]) {
			assert.doesNotMatch(src(f), /client\.mailboxOpen\(/, f);
			assert.match(src(f), /openMailboxLocked\(client,/, f);
		}
	});

	await test("the backfill of a folder holds the folder lock", () => {
		const s = src("lib/imap/backfill/backfill-full.ts");
		assert.match(s, /getMailboxLock\(opts\.path, \{ readOnly: true \}\)[\s\S]*backfillMailboxFullLocked\(opts\)/);
	});

	await test("syncMailbox abandons the pass when the selection is no longer the expected folder", () => {
		const s = src("lib/imap/imap-sync-mailbox.ts");
		assert.match(s, /if \(wrongFolder\(\)\) return;\n\t\tconst currentTop/);
		assert.match(s, /if \(wrongFolder\(\)\) return;\n\t\t\tfor await/);
		assert.match(s, /if \(aborted \|\| wrongFolder\(\)\)/);
		assert.match(s, /if \(aborted\) return;\n\t\t\tif \(maxUid > lastSeen\)/, "cursor not advanced");
	});

	await test("deltaFetch does not take a message seen in Drafts for a move", () => {
		const s = src("lib/imap/imap-delta-fetch.ts");
		const guard = s.indexOf('row.kind === "drafts"');
		assert.ok(guard > 0);
		assert.ok(guard < s.indexOf("Move detected"), "guard before the move detection");
	});

	await test("Drafts refused as the destination of a move (worker and web)", () => {
		assert.match(src("lib/imap/imap-move.ts"), /destMailboxRow\?\.kind === "drafts"/);
		assert.match(
			readFileSync(join(__dirname, "../../web/lib/actions/mailbox.ts"), "utf8"),
			/\(to as any\)\.kind === "drafts"\) return;/,
		);
	});

	if (failures) {
		console.log(`\n${failures} test(s) failed`);
		process.exit(1);
	}
	console.log("\nshared-connection-select: all green");
})();
