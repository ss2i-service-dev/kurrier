// IMAP move: arrival UID by Message-ID and not by position in the COPYUID (which Stalwart
// permutes), duplicates, missing Message-ID, deltaFetch cursor of the destination folder,
// IMAP / database-only choice and its wiring (worker and web). No database.
// Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/move-uids.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	cursorAtTop,
	destCursorAfterMove,
	heldUids,
	knownArrivals,
	matchMovedUids,
	normMessageId,
	shouldMoveImap,
} from "../../../packages/common/src/move-uids";

let failures = 0;
const test = async (label: string, fn: () => void | Promise<void>) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const root = join(__dirname, "../../..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

(async () => {
	await test("permutation: each message gets the UID of its Message-ID, not the COPYUID one", () => {
		// Observed with Stalwart: INBOX 920, 921 -> Archive 376, 377; COPYUID 920->377, 921->376.
		const moved = [
			{ id: "a", messageId: "<A@x>" },
			{ id: "b", messageId: "<B@x>" },
		];
		const found = [
			{ uid: 376, messageId: "<A@x>" },
			{ uid: 377, messageId: "<B@x>" },
		];
		const m = matchMovedUids(moved, found);
		assert.deepEqual([...m.assigned], [["a", 376], ["b", 377]]);
		assert.deepEqual(m.ambiguous, []);
		assert.deepEqual(m.missing, []);
	});

	await test("permutation of a batch of 8", () => {
		const moved = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, messageId: `<id${i}@example>` }));
		// arrival out of order, Message-ID in different case and without angle brackets
		const found = [5, 0, 7, 2, 1, 6, 3, 4].map((i, k) => ({ uid: 1000 + k, messageId: `ID${i}@EXAMPLE` }));
		const m = matchMovedUids(moved, found);
		for (const f of found) {
			const id = `m${Number(f.messageId!.slice(2, 3))}`;
			assert.equal(m.assigned.get(id), f.uid, id);
		}
		assert.equal(m.assigned.size, 8);
	});

	await test("Message-ID normalized (angle brackets, case, spaces)", () => {
		assert.equal(normMessageId(" <AbC@Example.ORG> "), "abc@example.org");
		assert.equal(normMessageId(null), "");
	});

	await test("duplicate at arrival: the most recent UID among those not taken", () => {
		const moved = [{ id: "a", messageId: "<X@x>" }];
		const found = [
			{ uid: 500, messageId: "<X@x>" },
			{ uid: 501, messageId: "<X@x>" },
		];
		assert.equal(matchMovedUids(moved, found).assigned.get("a"), 501);
		// 501 already held in the database by a copy with the same Message-ID: take 500
		const taken = heldUids(found, [{ uid: 501, messageId: "x@x" }]);
		assert.deepEqual([...taken], [501]);
		assert.equal(matchMovedUids(moved, found, taken).assigned.get("a"), 500);
	});

	await test("UID held in the database by a message with ANOTHER Message-ID (stale UID): not taken", () => {
		const found = [{ uid: 377, messageId: "<B@x>" }];
		assert.equal(heldUids(found, [{ uid: 377, messageId: "<autre@x>" }]).size, 0);
		assert.equal(heldUids(found, [{ uid: 999, messageId: "<B@x>" }]).size, 0);
	});

	await test("two messages of the batch with the same Message-ID: no UID (never guess)", () => {
		const moved = [
			{ id: "a", messageId: "<D@x>" },
			{ id: "b", messageId: "<D@x>" },
			{ id: "c", messageId: "<E@x>" },
		];
		const found = [
			{ uid: 10, messageId: "<D@x>" },
			{ uid: 11, messageId: "<D@x>" },
			{ uid: 12, messageId: "<E@x>" },
		];
		const m = matchMovedUids(moved, found);
		assert.deepEqual(m.ambiguous.sort(), ["a", "b"]);
		assert.deepEqual([...m.assigned], [["c", 12]]);
	});

	await test("missing Message-ID: only one candidate without a Message-ID for one message", () => {
		const one = matchMovedUids([{ id: "a", messageId: null }], [
			{ uid: 7, messageId: null },
			{ uid: 8, messageId: "<F@x>" },
		]);
		assert.deepEqual([...one.assigned], [["a", 7]]);
		const two = matchMovedUids([{ id: "a", messageId: null }], [
			{ uid: 7, messageId: null },
			{ uid: 9, messageId: "" },
		]);
		assert.deepEqual(two.ambiguous, ["a"]);
		assert.equal(two.assigned.size, 0);
		const none = matchMovedUids([{ id: "a", messageId: "" }], [{ uid: 8, messageId: "<F@x>" }]);
		assert.deepEqual(none.missing, ["a"]);
	});

	await test("message did not arrive (MOVE refused or partial): missing, to be checked in the source", () => {
		const m = matchMovedUids(
			[
				{ id: "a", messageId: "<A@x>" },
				{ id: "b", messageId: "<B@x>" },
			],
			[{ uid: 40, messageId: "<A@x>" }],
		);
		assert.deepEqual([...m.assigned], [["a", 40]]);
		assert.deepEqual(m.missing, ["b"]);
		assert.deepEqual(matchMovedUids([{ id: "a", messageId: "<A@x>" }], []).missing, ["a"]);
	});

	await test("cursor: set only if nothing was waiting above (deltaFetch up to date)", () => {
		assert.equal(cursorAtTop(99, 100), true);
		assert.equal(cursorAtTop(90, 100), false); // deltaFetch is behind: leave it alone
		assert.equal(cursorAtTop(99, 0), false); // UIDNEXT unknown
		assert.equal(cursorAtTop(120, 100), true); // cursor beyond the real one: brought back to the last UID
	});

	await test("known UIDs: any Message-ID of the batch (ambiguous and duplicates included)", () => {
		const found = [
			{ uid: 100, messageId: "<A@x>" },
			{ uid: 101, messageId: "<A@x>" }, // second copy (duplicate or ambiguous)
			{ uid: 102, messageId: "<foreign@x>" }, // arrived during the batch
			{ uid: 103, messageId: null },
		];
		const known = knownArrivals(found, ["a@x"], [999]);
		assert.deepEqual([...known].sort((a, b) => a - b), [100, 101, 999]);
		assert.equal(destCursorAfterMove(100, found.map((f) => ({ uid: f.uid, known: known.has(f.uid) }))), 101);
		// without Message-ID: known only if the batch itself has a message without a Message-ID
		assert.equal(knownArrivals(found, [null, "a@x"]).has(103), true);
		assert.equal(knownArrivals(found, ["a@x"]).has(103), false);
	});

	await test("cursor after: a batch of 70,000 UIDs does not exceed the argument limit", () => {
		const big = Array.from({ length: 70_000 }, (_, i) => ({ uid: 1000 + i, known: true }));
		assert.equal(destCursorAfterMove(1000, big), 70_999);
		big[50_000].known = false;
		assert.equal(destCursorAfterMove(1000, big), 50_999);
	});

	await test("cursor after: last real UID, or just below the first unknown one", () => {
		const all = [100, 101, 102].map((uid) => ({ uid, known: true }));
		assert.equal(destCursorAfterMove(100, all), 102);
		assert.equal(
			destCursorAfterMove(100, [...all.slice(0, 1), { uid: 101, known: false }, all[2]]),
			100,
		);
		// MOVE refused: nothing arrived, the cursor advanced before (107) goes back down to 99
		assert.equal(destCursorAfterMove(100, []), 99);
		// "u0:*" returns the last message even below u0: ignored
		assert.equal(destCursorAfterMove(100, [{ uid: 42, known: false }]), 99);
	});

	await test("IMAP / database-only choice: a synced folder is always moved over IMAP", () => {
		assert.equal(shouldMoveImap(false, true), true); // page without sync state (search)
		assert.equal(shouldMoveImap(undefined, true), true);
		assert.equal(shouldMoveImap(true, false), true);
		assert.equal(shouldMoveImap(false, false), false); // local folder: database only
	});

	await test("worker wiring: moveMail decides by itself and no longer writes the COPYUID UID", () => {
		const s = src("apps/worker/lib/imap/imap-move.ts");
		assert.match(s, /shouldMoveImap\(data\.moveImap, !!srcSync\)/);
		assert.match(s, /matchMovedUids\(movedRows, found, taken\)/);
		assert.doesNotMatch(s, /for \(const \[srcUid, destUid\] of uidMap\)/);
		// IMAP client checked before the database update
		assert.ok(s.indexOf("IMAP unavailable") < s.indexOf("await db.transaction"));
	});

	await test("worker wiring: UID removed in the transaction, copied back in slices, cursor written after the MOVE", () => {
		const s = src("apps/worker/lib/imap/imap-move.ts");
		const tx = s.slice(s.indexOf("await db.transaction"), s.indexOf("if (!moveImap) return;"));
		assert.match(tx, /#- '\{imap,uid\}'/);
		assert.doesNotMatch(s, /await setUid\(/);
		assert.match(s, /from \(values \$\{sql\.join\(/);
		assert.ok(s.indexOf("casCursor(cursor.id") > s.indexOf("client.messageMove("));
		assert.equal((s.match(/casCursor\(/g) ?? []).length, 2); // definition + a single call
		assert.doesNotMatch(s, /notInArray/);
	});

	await test("web wiring: trash retried 8 times, 5 s then exponential growth", () => {
		const s = src("apps/web/lib/actions/mailbox.ts");
		const body = s.slice(s.indexOf("export const moveToTrash = async"), s.indexOf("export const archiveThread = async"));
		const job = body.slice(body.indexOf('"mail:move"'));
		assert.match(job, /attempts: 8,\s*backoff: \{ type: "exponential", delay: 5000 \}/);
	});

	await test("web wiring: trash, archive and move ask the server for the state", () => {
		const s = src("apps/web/lib/actions/mailbox.ts");
		const calls = s.match(/moveImap = shouldMoveImap\(moveImap, await imapSynced\(/g) ?? [];
		assert.equal(calls.length, 3);
		for (const fn of ["moveToTrash", "archiveThread", "moveToFolder"]) {
			const body = s.slice(s.indexOf(`export const ${fn} = async`));
			const end = body.indexOf("\nexport ");
			assert.match(body.slice(0, end), /shouldMoveImap\(moveImap, await imapSynced\(/, fn);
		}
	});

	if (failures) {
		console.error(`\n${failures} test(s) failed`);
		process.exit(1);
	}
	console.log("\nmove-uids: all green");
})();
