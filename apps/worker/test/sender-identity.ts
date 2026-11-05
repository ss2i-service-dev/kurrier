// Sender identity of an MCP reply (lib/mcp/sender-identity.ts): a message sent from A to
// B, two identities of the same user, is a single `messages` row that moves from A's Sent
// to B's Inbox (and back) as syncs run: the reply must go out from B (the recipient) on
// every run, whatever the folder at that moment.
// No database. Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/sender-identity.ts
import assert from "node:assert/strict";
import { pickSenderIdentity } from "../lib/mcp/sender-identity";

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

const A = { id: "a0000000-0000-4000-8000-000000000001", value: "alice@example.net" };
const B = { id: "b0000000-0000-4000-8000-000000000002", value: "alice@example.com" };
const C = { id: "c0ffee00-0000-4000-8000-000000000003", value: "bob@example.org" };

// Message sent by A to B: From A, To B.
const message = {
	from: { value: [{ address: A.value, name: "Alice (personal)" }] },
	to: { value: [{ address: "Alice@Example.COM", name: "Alice" }] },
	cc: { value: [] },
	deliveredTo: null,
};

const shuffle = <T,>(arr: T[], seed: number) => {
	const a = [...arr];
	let s = seed;
	for (let i = a.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) % 2147483648;
		const j = s % (i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
};

test("same message in A's Sent and B's Inbox, To = B: the reply goes out from B, on every run", () => {
	for (let run = 0; run < 100; run++) {
		// The row is sometimes in A's folder, sometimes in B's; the order of the
		// identities varies too.
		const mailboxIdentityId = run % 2 ? A.id : B.id;
		const r = pickSenderIdentity({
			identities: shuffle([A, B, C], run + 1),
			message,
			mailboxIdentityId,
		});
		assert.equal(r.identity.id, B.id, `run ${run}, folder of ${mailboxIdentityId === A.id ? "A" : "B"}`);
		assert.equal(r.reason, "recipient");
	}
});

test("explicit identity parameter: takes priority, even if the message is addressed to B", () => {
	const r = pickSenderIdentity({ identities: [A, B], message, explicit: A, mailboxIdentityId: B.id });
	assert.equal(r.identity.id, A.id);
	assert.equal(r.reason, "explicit");
});

test("recipient in Cc then Delivered-To, To before Cc", () => {
	const cc = pickSenderIdentity({
		identities: [A, B, C],
		message: { to: { value: [{ address: "client@example.com" }] }, cc: { value: [{ address: C.value }] } },
		mailboxIdentityId: A.id,
	});
	assert.equal(cc.identity.id, C.id);
	const delivered = pickSenderIdentity({
		identities: [A, B, C],
		message: { to: { value: [{ address: "liste@example.com" }] }, deliveredTo: B.value },
		mailboxIdentityId: A.id,
	});
	assert.equal(delivered.identity.id, B.id);
	const both = pickSenderIdentity({
		identities: [A, B, C],
		message: { to: { value: [{ address: C.value }] }, cc: { value: [{ address: B.value }] } },
		mailboxIdentityId: A.id,
	});
	assert.equal(both.identity.id, C.id);
});

test("no own address among the recipients: the folder's identity", () => {
	const r = pickSenderIdentity({
		identities: [A, B],
		message: { to: { value: [{ address: "client@example.com" }] } },
		mailboxIdentityId: A.id,
	});
	assert.equal(r.identity.id, A.id);
	assert.equal(r.reason, "mailbox");
	// Addresses as a string (older records).
	const s = pickSenderIdentity({ identities: [A, B], message: { to: "x@y, alice@example.com" }, mailboxIdentityId: A.id });
	assert.equal(s.identity.id, B.id);
});

test("nothing matches: explicit error listing the identities", () => {
	assert.throws(
		() => pickSenderIdentity({ identities: [A, B], message: { to: { value: [{ address: "x@y" }] } }, mailboxIdentityId: "unknown" }),
		/pass 'identity' \(alice@example\.net, alice@example\.com\)/,
	);
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
