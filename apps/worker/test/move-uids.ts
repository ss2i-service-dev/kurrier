// Deplacement IMAP (OI 10286) : UID d'arrivee par Message-ID et non par la position dans le
// COPYUID (que Stalwart permute), doublons, Message-ID absent, curseur deltaFetch du dossier
// d'arrivee, choix IMAP / base seule et son branchement (worker et web). Aucune base.
// Lancement (depuis la racine) :
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
	await test("permutation : chaque message recoit l'UID de son Message-ID, pas celui du COPYUID", () => {
		// Constat du 04/11 : INBOX 920, 921 -> Archive 376, 377 ; COPYUID 920->377, 921->376.
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

	await test("permutation d'un lot de 8 (7 sur 8 permutes le 04/11 a 07:33)", () => {
		const moved = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, messageId: `<id${i}@ss2i>` }));
		// arrivee dans le desordre, Message-ID en casse differente et sans chevrons
		const found = [5, 0, 7, 2, 1, 6, 3, 4].map((i, k) => ({ uid: 1000 + k, messageId: `ID${i}@SS2I` }));
		const m = matchMovedUids(moved, found);
		for (const f of found) {
			const id = `m${Number(f.messageId!.slice(2, 3))}`;
			assert.equal(m.assigned.get(id), f.uid, id);
		}
		assert.equal(m.assigned.size, 8);
	});

	await test("Message-ID normalise (chevrons, casse, espaces)", () => {
		assert.equal(normMessageId(" <AbC@Example.ORG> "), "abc@example.org");
		assert.equal(normMessageId(null), "");
	});

	await test("doublon a l'arrivee : l'UID le plus recent parmi ceux qui ne sont pas pris", () => {
		const moved = [{ id: "a", messageId: "<X@x>" }];
		const found = [
			{ uid: 500, messageId: "<X@x>" },
			{ uid: 501, messageId: "<X@x>" },
		];
		assert.equal(matchMovedUids(moved, found).assigned.get("a"), 501);
		// 501 deja tenu en base par une copie de meme Message-ID : on prend 500
		const taken = heldUids(found, [{ uid: 501, messageId: "x@x" }]);
		assert.deepEqual([...taken], [501]);
		assert.equal(matchMovedUids(moved, found, taken).assigned.get("a"), 500);
	});

	await test("UID tenu en base par un message d'un AUTRE Message-ID (UID perime) : pas pris", () => {
		const found = [{ uid: 377, messageId: "<B@x>" }];
		assert.equal(heldUids(found, [{ uid: 377, messageId: "<autre@x>" }]).size, 0);
		assert.equal(heldUids(found, [{ uid: 999, messageId: "<B@x>" }]).size, 0);
	});

	await test("deux messages du lot avec le meme Message-ID : aucun UID (jamais deviner)", () => {
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

	await test("Message-ID absent : seulement un candidat sans Message-ID pour un message", () => {
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

	await test("message pas arrive (MOVE refuse ou partiel) : missing, a verifier dans la source", () => {
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

	await test("curseur : pose seulement si rien n'attendait au-dessus (deltaFetch a jour)", () => {
		assert.equal(cursorAtTop(99, 100), true);
		assert.equal(cursorAtTop(90, 100), false); // deltaFetch en retard : on n'y touche pas
		assert.equal(cursorAtTop(99, 0), false); // UIDNEXT inconnu
		assert.equal(cursorAtTop(120, 100), true); // curseur au-dela du reel : ramene au dernier UID
	});

	await test("UID connus : tout Message-ID du lot (ambigus et doublons compris)", () => {
		const found = [
			{ uid: 100, messageId: "<A@x>" },
			{ uid: 101, messageId: "<A@x>" }, // seconde copie (doublon ou ambigu)
			{ uid: 102, messageId: "<etranger@x>" }, // arrive pendant le lot
			{ uid: 103, messageId: null },
		];
		const known = knownArrivals(found, ["a@x"], [999]);
		assert.deepEqual([...known].sort((a, b) => a - b), [100, 101, 999]);
		assert.equal(destCursorAfterMove(100, found.map((f) => ({ uid: f.uid, known: known.has(f.uid) }))), 101);
		// sans Message-ID : connu seulement si le lot a lui-meme un message sans Message-ID
		assert.equal(knownArrivals(found, [null, "a@x"]).has(103), true);
		assert.equal(knownArrivals(found, ["a@x"]).has(103), false);
	});

	await test("curseur apres : un lot de 70 000 UID ne depasse pas la limite d'arguments", () => {
		const big = Array.from({ length: 70_000 }, (_, i) => ({ uid: 1000 + i, known: true }));
		assert.equal(destCursorAfterMove(1000, big), 70_999);
		big[50_000].known = false;
		assert.equal(destCursorAfterMove(1000, big), 50_999);
	});

	await test("curseur apres : dernier UID reel, ou juste sous le premier inconnu", () => {
		const all = [100, 101, 102].map((uid) => ({ uid, known: true }));
		assert.equal(destCursorAfterMove(100, all), 102);
		assert.equal(
			destCursorAfterMove(100, [...all.slice(0, 1), { uid: 101, known: false }, all[2]]),
			100,
		);
		// MOVE refuse : rien n'est arrive, le curseur avance avant (107) redescend a 99
		assert.equal(destCursorAfterMove(100, []), 99);
		// « u0:* » rend le dernier message meme sous u0 : ignore
		assert.equal(destCursorAfterMove(100, [{ uid: 42, known: false }]), 99);
	});

	await test("choix IMAP / base seule : un dossier synchronise est toujours deplace sur IMAP", () => {
		assert.equal(shouldMoveImap(false, true), true); // page sans etat de synchro (recherche)
		assert.equal(shouldMoveImap(undefined, true), true);
		assert.equal(shouldMoveImap(true, false), true);
		assert.equal(shouldMoveImap(false, false), false); // dossier local : base seule
	});

	await test("branchement worker : moveMail decide lui-meme et n'ecrit plus l'UID du COPYUID", () => {
		const s = src("apps/worker/lib/imap/imap-move.ts");
		assert.match(s, /shouldMoveImap\(data\.moveImap, !!srcSync\)/);
		assert.match(s, /matchMovedUids\(movedRows, found, taken\)/);
		assert.doesNotMatch(s, /for \(const \[srcUid, destUid\] of uidMap\)/);
		// client IMAP verifie avant la mise a jour en base
		assert.ok(s.indexOf("IMAP indisponible") < s.indexOf("await db.transaction"));
	});

	await test("branchement worker : UID retire dans la transaction, recopie par tranches, curseur ecrit apres le MOVE", () => {
		const s = src("apps/worker/lib/imap/imap-move.ts");
		const tx = s.slice(s.indexOf("await db.transaction"), s.indexOf("if (!moveImap) return;"));
		assert.match(tx, /#- '\{imap,uid\}'/);
		assert.doesNotMatch(s, /await setUid\(/);
		assert.match(s, /from \(values \$\{sql\.join\(/);
		assert.ok(s.indexOf("casCursor(cursor.id") > s.indexOf("client.messageMove("));
		assert.equal((s.match(/casCursor\(/g) ?? []).length, 2); // definition + un seul appel
		assert.doesNotMatch(s, /notInArray/);
	});

	await test("branchement web : corbeille rejouee 8 fois, 5 s puis croissance exponentielle", () => {
		const s = src("apps/web/lib/actions/mailbox.ts");
		const body = s.slice(s.indexOf("export const moveToTrash = async"), s.indexOf("export const archiveThread = async"));
		const job = body.slice(body.indexOf('"mail:move"'));
		assert.match(job, /attempts: 8,\s*backoff: \{ type: "exponential", delay: 5000 \}/);
	});

	await test("branchement web : corbeille, archive et deplacement demandent l'etat au serveur", () => {
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
		console.error(`\n${failures} test(s) en echec`);
		process.exit(1);
	}
	console.log("\nmove-uids : tout est vert");
})();
