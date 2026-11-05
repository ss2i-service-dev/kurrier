// Sender blocking (packages/common/src/sender-block.ts): address, domain and subdomain
// matching, public mailbox provider domains, the user's own domains. No database.
// Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/sender-block.ts
import assert from "node:assert/strict";
import { blockOptionsFor, emailDomain, isBlockedSender, isFreeMailDomain, isOwnDomain, normalizeAddress, normalizeDomain } from "../../../packages/common/src/sender-block";

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

const domain = [{ kind: "domain" as const, value: "spammer.example" }];
const address = [{ kind: "address" as const, value: "News@Example.org" }];

test("exact domain and subdomains", () => {
	assert.equal(isBlockedSender("a@spammer.example", domain), true);
	assert.equal(isBlockedSender("A@MAIL.SPAMMER.EXAMPLE", domain), true);
	assert.equal(isBlockedSender("a@eu.mail.spammer.example", domain), true);
});

test("no suffix false positive", () => {
	assert.equal(isBlockedSender("a@notspammer.example", domain), false);
	assert.equal(isBlockedSender("a@spammer.example.evil.org", domain), false);
	assert.equal(isBlockedSender("spammer.example@other.org", domain), false);
});

test("exact address, case ignored, \"Name <address>\" form", () => {
	assert.equal(isBlockedSender("news@example.org", address), true);
	assert.equal(isBlockedSender("News <NEWS@example.org>", address), true);
	assert.equal(isBlockedSender("other@example.org", address), false);
	assert.equal(isBlockedSender("", address), false);
	assert.equal(isBlockedSender(null, domain), false);
});

test("normalization", () => {
	assert.equal(normalizeDomain(" @*.Spammer.example. "), "spammer.example");
	assert.equal(normalizeDomain("*.x.org"), "x.org");
	assert.equal(emailDomain("Name <a@Mail.X.org>"), "mail.x.org");
	assert.equal(normalizeAddress("Name <A@B.fr>"), "a@b.fr");
});

test("public mailbox provider domains", () => {
	for (const d of ["gmail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "hotmail.co.uk", "yahoo.com", "yahoo.fr", "orange.fr", "free.fr", "icloud.com", "live.com", "live.fr"]) {
		assert.equal(isFreeMailDomain(d), true, d);
	}
	for (const d of ["spammer.example", "example.com", "customer.example", "outlook-tools.com", "hotmail.evil.org"]) {
		assert.equal(isFreeMailDomain(d), false, d);
	}
});

test("the user's own domains", () => {
	const own = ["example.com", "example.net"];
	assert.equal(isOwnDomain("example.com", own), true);
	assert.equal(isOwnDomain("mail.example.net", own), true);
	assert.equal(isOwnDomain("spammer.example", own), false);
});

test("offered options: domain only if it can be blocked", () => {
	const own = ["example.com"];
	assert.deepEqual(blockOptionsFor("Sales <v@spammer.example>", own), { address: "v@spammer.example", domain: "spammer.example" });
	assert.deepEqual(blockOptionsFor("x@gmail.com", own), { address: "x@gmail.com", domain: null });
	assert.deepEqual(blockOptionsFor("x@example.com", own), { address: "x@example.com", domain: null });
	assert.deepEqual(blockOptionsFor("x@hotmail.fr", own), { address: "x@hotmail.fr", domain: null });
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
