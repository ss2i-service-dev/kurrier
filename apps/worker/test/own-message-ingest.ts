// Integration point of isOwnMessage (lib/own-message.ts): the identity addresses of the owner
// come from the database (ownerEmailAddresses), and a received message that the owner wrote
// is stored as read, list row (mailbox_threads.unread_count) included. An external sender stays
// unread, and the identity of another owner does not count.
// Test database: see mcp-test-env.ts for the launch:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/own-message-ingest.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, identities, mailboxThreads, messages } from "@db";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { ownerEmailAddresses, storeMessageInThread } from "../lib/message-payload-parser";
import { isOwnMessage } from "../lib/own-message";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

function raw(o: { id: string; from: string; to: string; cc?: string }) {
	return [
		`From: ${o.from}`,
		`To: ${o.to}`,
		o.cc ? `Cc: ${o.cc}` : null,
		`Subject: copy ${o.id}`,
		`Date: Fri, 06 Nov 2026 08:00:00 +0000`,
		`Message-ID: ${o.id}`,
		``,
		`body ${o.id}`,
	].filter((l) => l !== null).join("\r\n");
}

// Reproduces the decision of parseAndStoreEmail: seen comes from the server, except for a message of the owner.
async function ingest(f: Fixture, r: string) {
	const parsed = await simpleParser(r);
	const addresses = await ownerEmailAddresses(f.user.id);
	const from = parsed.from?.value?.[0]?.address;
	const seen = isOwnMessage(from, addresses);
	const decorated = {
		...parsed,
		createdAt: parsed.date,
		mailboxId: f.inbox.id,
		workspaceId: f.workspace.id,
		ownerId: f.user.id,
		headersJson: {},
		references: null,
		seen,
		html: "",
		snippet: parsed.text?.slice(0, 100) ?? null,
	};
	return storeMessageInThread(parsed, decorated, { ownerId: f.user.id, workspaceId: f.workspace.id });
}

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const tag = `${Date.now()}`;
	const id = (n: string) => `<${n}-${tag}@example.org>`;

	// A second e-mail identity for alice, plus a domain identity that must not count.
	const alias = `Dev-${tag}@test.invalid`;
	await db.insert(identities).values({ ownerId: a.user.id, workspaceId: a.workspace.id, kind: "email", value: alias, status: "verified" });
	await db.insert(identities).values({ ownerId: a.user.id, workspaceId: a.workspace.id, kind: "domain", value: "test.invalid", status: "verified" });

	const addrs = await ownerEmailAddresses(a.user.id);
	assert(addrs.includes(a.email.toLowerCase()) && addrs.includes(alias.toLowerCase()), "alice's addresses: her identity and her alias, lowercase");
	assert(!addrs.includes("test.invalid") && !addrs.includes(b.email.toLowerCase()), "neither the domain nor bob's identity");

	// 1. Alice copies herself: the message comes back into her Inbox, from her own address.
	const own = await ingest(a, raw({ id: id("own"), from: `Alice <${a.email.toUpperCase()}>`, to: "client@example.com", cc: alias }));
	const [ownRow] = await db.select().from(messages).where(eq(messages.id, own!.message.id));
	assert(ownRow.seen === true, "message from her own identity (different case): stored as read");
	const [ownMt] = await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, own!.threadId), eq(mailboxThreads.mailboxId, a.inbox.id)));
	assert(ownMt.unreadCount === 0, `list row without unread (${ownMt.unreadCount})`);

	// 2. From her alias.
	const viaAlias = await ingest(a, raw({ id: id("alias"), from: alias, to: "client@example.com" }));
	const [aliasMt] = await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, viaAlias!.threadId), eq(mailboxThreads.mailboxId, a.inbox.id)));
	assert(aliasMt.unreadCount === 0, "message sent from an alias of the user: no unread");

	// 3. External sender: unread.
	const ext = await ingest(a, raw({ id: id("ext"), from: "Client <client@example.com>", to: a.email }));
	const [extRow] = await db.select().from(messages).where(eq(messages.id, ext!.message.id));
	const [extMt] = await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, ext!.threadId), eq(mailboxThreads.mailboxId, a.inbox.id)));
	assert(extRow.seen === false && extMt.unreadCount === 1, "external sender: unread, one unread in the list");

	// 4. Alice's address at bob's (spoofing or a plain correspondent): not an identity of bob.
	const spoof = await ingest(b, raw({ id: id("spoof"), from: a.email, to: b.email }));
	const [spoofRow] = await db.select().from(messages).where(eq(messages.id, spoof!.message.id));
	assert(spoofRow.seen === false, "the address of another owner is not an identity of bob: unread");

	if (process.exitCode) process.exit(process.exitCode);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => {
	console.error(err);
	process.exit(1);
});
