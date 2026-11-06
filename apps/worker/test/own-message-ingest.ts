// Point d'integration de isOwnMessage (lib/own-message.ts) : les adresses d'identite du
// proprietaire viennent de la base (ownerEmailAddresses), et un message recu qu'il a
// lui-meme ecrit entre lu, ligne de liste (mailbox_threads.unread_count) comprise. Un
// expediteur externe reste non lu, et l'identite d'un autre proprietaire ne compte pas.
// Base de test : voir mcp-test-env.ts pour le lancement :
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
		`Subject: copie ${o.id}`,
		`Date: Fri, 06 Nov 2026 08:00:00 +0000`,
		`Message-ID: ${o.id}`,
		``,
		`corps ${o.id}`,
	].filter((l) => l !== null).join("\r\n");
}

// Reproduit la decision de parseAndStoreEmail : seen vient du serveur, sauf message du proprietaire.
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

	// Seconde identite de mail pour alice, plus une identite de domaine qui ne doit pas compter.
	const alias = `Dev-${tag}@test.invalid`;
	await db.insert(identities).values({ ownerId: a.user.id, workspaceId: a.workspace.id, kind: "email", value: alias, status: "verified" });
	await db.insert(identities).values({ ownerId: a.user.id, workspaceId: a.workspace.id, kind: "domain", value: "test.invalid", status: "verified" });

	const addrs = await ownerEmailAddresses(a.user.id);
	assert(addrs.includes(a.email.toLowerCase()) && addrs.includes(alias.toLowerCase()), "adresses d'alice : son identite et son alias, en minuscules");
	assert(!addrs.includes("test.invalid") && !addrs.includes(b.email.toLowerCase()), "ni le domaine ni l'identite de bob");

	// 1. Alice s'ecrit en copie : le message revient dans son Inbox, de sa propre adresse.
	const own = await ingest(a, raw({ id: id("own"), from: `Alice <${a.email.toUpperCase()}>`, to: "maud@client.fr", cc: alias }));
	const [ownRow] = await db.select().from(messages).where(eq(messages.id, own!.message.id));
	assert(ownRow.seen === true, "message de sa propre identite (casse differente) : enregistre lu");
	const [ownMt] = await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, own!.threadId), eq(mailboxThreads.mailboxId, a.inbox.id)));
	assert(ownMt.unreadCount === 0, `ligne de liste sans non lu (${ownMt.unreadCount})`);

	// 2. Depuis son alias.
	const viaAlias = await ingest(a, raw({ id: id("alias"), from: alias, to: "maud@client.fr" }));
	const [aliasMt] = await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, viaAlias!.threadId), eq(mailboxThreads.mailboxId, a.inbox.id)));
	assert(aliasMt.unreadCount === 0, "message envoye depuis un alias de l'utilisateur : aucun non lu");

	// 3. Expediteur externe : non lu.
	const ext = await ingest(a, raw({ id: id("ext"), from: "Maud <maud@client.fr>", to: a.email }));
	const [extRow] = await db.select().from(messages).where(eq(messages.id, ext!.message.id));
	const [extMt] = await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, ext!.threadId), eq(mailboxThreads.mailboxId, a.inbox.id)));
	assert(extRow.seen === false && extMt.unreadCount === 1, "expediteur externe : non lu, un non lu en liste");

	// 4. Adresse d'alice chez bob (usurpation ou simple correspondant) : pas une identite de bob.
	const spoof = await ingest(b, raw({ id: id("spoof"), from: a.email, to: b.email }));
	const [spoofRow] = await db.select().from(messages).where(eq(messages.id, spoof!.message.id));
	assert(spoofRow.seen === false, "l'adresse d'un autre proprietaire n'est pas une identite de bob : non lu");

	if (process.exitCode) process.exit(process.exitCode);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => {
	console.error(err);
	process.exit(1);
});
