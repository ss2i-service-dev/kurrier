// Received message whose sender is an identity of the owner (lib/own-message.ts). Sent from
// owner@ with an alias in copy, the message comes back into the Inbox of owner@ without the
// \Seen flag and stayed unread.
// No database. Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/own-message.ts
import assert from "node:assert/strict";
import { isOwnMessage } from "../lib/own-message";

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

const identities = ["owner@example.org", "Own.Er@Example.com", "example.net"];

test("sender = identity of the owner: message of the user", () => {
	assert.equal(isOwnMessage("owner@example.org", identities), true);
});

test("comparison without case or spaces, on both sides", () => {
	assert.equal(isOwnMessage("  Owner@EXAMPLE.org ", identities), true);
	assert.equal(isOwnMessage("own.er@example.com", identities), true);
});

test("another identity of the same owner counts too", () => {
	assert.equal(isOwnMessage("own.er@example.com", ["owner@example.org", "own.er@example.com"]), true);
});

test("external sender: not concerned", () => {
	assert.equal(isOwnMessage("client@example.com", identities), false);
});

test("no false positive on a substring or a domain", () => {
	assert.equal(isOwnMessage("xowner@example.org", identities), false);
	assert.equal(isOwnMessage("owner@example.org.evil.test", identities), false);
	assert.equal(isOwnMessage("other@example.org", identities), false);
});

test("domain identity (without @): does not allow the whole domain", () => {
	assert.equal(isOwnMessage("someone@example.net", identities), false);
});

test("no sender or no identity: not concerned", () => {
	assert.equal(isOwnMessage(null, identities), false);
	assert.equal(isOwnMessage(undefined, identities), false);
	assert.equal(isOwnMessage("", identities), false);
	assert.equal(isOwnMessage("owner@example.org", []), false);
});

if (failures) {
	console.error(`${failures} failing test(s)`);
	process.exit(1);
}
