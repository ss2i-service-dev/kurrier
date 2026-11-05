// Sender blocking at message granularity: web message selection, worker move plan
// (mixed thread / whole thread), X-Kurrier-Auto header, SSRF guard.
// No database. Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/message-move.ts
import assert from "node:assert/strict";
import { planMessageMove } from "../../../packages/common/src/message-move";
import { groupBlockedMessages } from "../../../packages/common/src/sender-block";
import { autoMailKind } from "../../../packages/common/src/auto-mail";
import { assertPublicHttpsUrl } from "../../web/lib/safe-public-url";

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

const domain = [{ kind: "domain" as const, value: "vendor-example.com" }];
// Inbox M1: mixed thread T1 (m1 blocked, m2 not), fully blocked thread T2 (m3, m4), foreign thread T3 (m5).
const rows = [
	{ id: "m1", threadId: "T1", mailboxId: "M1", address: "a@vendor-example.com" },
	{ id: "m2", threadId: "T1", mailboxId: "M1", address: "ami@gmail.com" },
	{ id: "m3", threadId: "T2", mailboxId: "M1", address: "b@mail.vendor-example.com" },
	{ id: "m4", threadId: "T2", mailboxId: "M1", address: "c@vendor-example.com" },
	{ id: "m5", threadId: "T3", mailboxId: "M1", address: "x@example.org" },
	{ id: "m6", threadId: "T4", mailboxId: "M2", address: "d@vendor-example.com" },
];

(async () => {
	await test("web: only the sender's messages, per folder", () => {
		const g = groupBlockedMessages(rows, domain);
		assert.deepEqual(g.get("M1")!.map((m) => m.id), ["m1", "m3", "m4"]);
		assert.deepEqual(g.get("M2")!.map((m) => m.id), ["m6"]);
		assert.equal(g.has("M3"), false);
	});

	await test("worker: mixed thread partial, fully blocked thread whole", () => {
		const inbox = rows.filter((r) => r.mailboxId === "M1");
		const g = groupBlockedMessages(rows, domain).get("M1")!;
		const plan = planMessageMove(inbox, g.map((m) => m.id));
		assert.deepEqual(plan.messageIds.sort(), ["m1", "m3", "m4"]);
		assert.deepEqual(plan.partialThreadIds, ["T1"]);
		assert.deepEqual(plan.fullThreadIds, ["T2"]);
	});

	await test("worker: a message outside the source folder is never moved", () => {
		const plan = planMessageMove([{ id: "m1", threadId: "T1" }], ["m1", "ghost"]);
		assert.deepEqual(plan.messageIds, ["m1"]);
		assert.deepEqual(plan.fullThreadIds, ["T1"]);
		assert.deepEqual(planMessageMove([{ id: "m2", threadId: "T1" }], ["m1"]).messageIds, []);
	});

	await test("en-tete X-Kurrier-Auto: Map mailparser, headers_json, absent", () => {
		assert.equal(autoMailKind(new Map([["x-kurrier-auto", "unsubscribe"]])), "unsubscribe");
		assert.equal(autoMailKind({ "x-kurrier-auto": " Unsubscribe " }), "unsubscribe");
		assert.equal(autoMailKind({ "x-kurrier-auto": ["unsubscribe"] }), "unsubscribe");
		assert.equal(autoMailKind(new Map([["subject", "x"]])), null);
		assert.equal(autoMailKind(null), null);
	});

	await test("SSRF: IPv4 mappee (pointee, hexadecimale), NAT64, boucle, prive", async () => {
		for (const u of [
			"https://[::ffff:7f00:1]/",
			"https://[::ffff:127.0.0.1]/",
			"https://[64:ff9b::7f00:1]/",
			"https://[64:ff9b::a00:1]/",
			"https://[::1]/",
			"https://10.0.0.1/",
			"https://192.168.1.5/",
			"https://169.254.169.254/",
			"https://[fd00::1]/",
		]) {
			await assert.rejects(() => assertPublicHttpsUrl(u), u);
		}
		await assert.rejects(() => assertPublicHttpsUrl("http://8.8.8.8/"), /not https/);
		await assertPublicHttpsUrl("https://8.8.8.8/");
		await assertPublicHttpsUrl("https://[2606:4700:4700::1111]/");
	});

	if (failures) {
		console.error(`\n${failures} failure(s)`);
		process.exit(1);
	}
	console.log("\nall ok");
})();
