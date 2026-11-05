// "Add an e-mail address" form: an SMTP account already used by an identity is no longer offered (after
// upstream 8189d986, #651). Before: the same account stayed in the list and a second add created a duplicate
// identity on the same address.
// Run from the repository root:
//   node_modules/.bin/tsx apps/web/test/identity-provider-options.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { availableProviderOptions } from "../lib/identity-provider-options";

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

const smtp = (id: number, username: string) => ({ linkRow: { id }, username });
const usernameOf = (a: { username: string }) => a.username;
const options = [
	{ label: "SES", value: "provider-7" },
	{ label: "SMTP a", value: "smtp-1" },
	{ label: "SMTP b", value: "smtp-2" },
	{ label: "SMTP c", value: "smtp-3" },
	{ label: "SMTP d", value: "smtp-4" },
	{ label: "SMTP unknown", value: "smtp-99" },
];
const accounts = [
	smtp(1, "a@example.org"),
	smtp(2, "B@example.org"),
	smtp(3, "a@example.org"),
	smtp(4, "  "),
];
const values = (opts: { value: string }[]) => opts.map((o) => o.value);

test("an SMTP account already used by an identity disappears (case ignored)", () => {
	assert.deepEqual(values(availableProviderOptions(options, accounts, ["b@EXAMPLE.org"], usernameOf)), ["provider-7", "smtp-1"]);
});
test("two SMTP accounts on the same address: only one offered", () => {
	assert.deepEqual(values(availableProviderOptions(options, accounts, [], usernameOf)), ["provider-7", "smtp-1", "smtp-2"]);
});
test("SMTP account without address or not found is left out, provider kept", () => {
	const out = values(availableProviderOptions(options, accounts, ["a@example.org", "b@example.org"], usernameOf));
	assert.deepEqual(out, ["provider-7"]);
});

const form = readFileSync(join(__dirname, "../components/dashboard/identities/add-email-identity-form.tsx"), "utf8");
test("the form goes through availableProviderOptions", () => {
	assert.ok(/availableProviderOptions\(/.test(form), "availableProviderOptions not called");
	assert.ok(/options: providerChoices,/.test(form), "the select must receive the filtered list, not providerOptions");
	assert.ok(!/options: providerOptions,/.test(form), "raw providerOptions still passed to the select");
});

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
