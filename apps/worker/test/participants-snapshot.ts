// Participants of a thread: blank sender in the thread list. Messages sent from kurrier store
// `from` as a plain string; the thread summary only read the mailparser object. And a thread
// row without participants (thread merge) was never repaired: NULL || x = NULL.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/participants-snapshot.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAddressField } from "../../../packages/common/src/address-field";

let failed = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failed++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const root = join(__dirname, "..", "..", "..");
const mailSrc = readFileSync(join(root, "packages/common/src/mail.ts"), "utf8");

test("mailparser object of a received message", () => {
	assert.deepEqual(
		parseAddressField({ value: [{ name: "Jane Doe", address: "jane@example.org" }], text: "x" }),
		[{ name: "Jane Doe", address: "jane@example.org" }],
	);
});

test("plain string of a message sent from kurrier", () => {
	assert.deepEqual(parseAddressField("jane@example.org"), [{ name: null, address: "jane@example.org" }]);
});

test("string with a quoted name containing a comma, several addresses", () => {
	assert.deepEqual(parseAddressField('"Doe, Jane" <jane@example.org>, dev@example.org'), [
		{ name: "Doe, Jane", address: "jane@example.org" },
		{ name: null, address: "dev@example.org" },
	]);
});

test("empty, null, string without an address", () => {
	assert.deepEqual(parseAddressField(null), []);
	assert.deepEqual(parseAddressField(""), []);
	assert.deepEqual(parseAddressField("undisclosed-recipients:;"), []);
});

test("the thread summary reads the field through parseAddressField", () => {
	assert.match(mailSrc, /parseAddressField\(/);
});

test("the thread upsert repairs a row with NULL participants", () => {
	assert.match(mailSrc, /coalesce\(\$\{mailboxThreads\.participants\}, '\{\}'::jsonb\) \|\| EXCLUDED\.participants/);
});

if (failed) {
	console.log(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nparticipants-snapshot: all tests pass");
