// The same mail shown twice in a thread. A reply sent to a recipient who also receives it in
// copy in the same mailbox exists twice in the database with the same Message-ID, the copy of
// the Sent folder and the copy received in the Inbox. fetchWebMailThreadDetail returns both,
// the thread displayed them one after the other.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/thread-dedupe.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dedupeThreadMessages } from "../lib/thread-dedupe";

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

// A thread in chronological order, as fetchWebMailThreadDetail returns it.
const thread = [
	{ id: "4dd6", messageId: "<e6de2678@mailer.example>", mailboxId: "archive" },
	{ id: "e9e8", messageId: "<90a40910@example.org>", mailboxId: "sent" },
	{ id: "35d8", messageId: "<DB8PR01@exchange.example>", mailboxId: "inbox" },
	{ id: "8fad", messageId: "<f9903c06@example.org>", mailboxId: "sent" },
	{ id: "60fb", messageId: "<f9903c06@example.org>", mailboxId: "inbox" },
];

test("the reply received in copy appears only once", () => {
	const ids = dedupeThreadMessages(thread).map((m) => m.id);
	assert.deepEqual(ids, ["4dd6", "e9e8", "35d8", "60fb"]);
});

test("keeps the most recent copy (the one that decides the folder of the thread)", () => {
	const out = dedupeThreadMessages(thread);
	assert.equal(out[out.length - 1].mailboxId, "inbox");
});

test("Message-ID compared without case, spaces or angle brackets", () => {
	const out = dedupeThreadMessages([
		{ id: "a", messageId: " <ABC@x.fr> " },
		{ id: "b", messageId: "abc@X.FR" },
	]);
	assert.deepEqual(out.map((m) => m.id), ["b"]);
});

test("empty or missing Message-ID: never merged", () => {
	const out = dedupeThreadMessages([
		{ id: "a", messageId: "" },
		{ id: "b", messageId: "" },
		{ id: "c", messageId: null },
		{ id: "d" },
	]);
	assert.deepEqual(out.map((m) => m.id), ["a", "b", "c", "d"]);
});

test("thread without duplicate: unchanged, order kept", () => {
	const ids = thread.slice(0, 4);
	assert.deepEqual(dedupeThreadMessages(ids), ids);
});

// Wiring: the three renderings of the thread (classic direct, classic soft navigation,
// new interface) show the deduplicated list.
const root = join(__dirname, "..");
const mailDir = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/[mailboxSlug]";
for (const file of [
	`${mailDir}/threads/[threadId]/page.tsx`,
	`${mailDir}/@thread/(.)threads/[threadId]/page.tsx`,
	"components/k/thread-page.tsx",
]) {
	test(`wiring: ${file}`, () => {
		const src = readFileSync(join(root, file), "utf8");
		assert.match(src, /dedupeThreadMessages\(/);
	});
}

if (failures) {
	console.log(`\n${failures} failing test(s)`);
	process.exit(1);
}
console.log("\nall tests pass");
