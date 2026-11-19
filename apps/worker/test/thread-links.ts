// Fils : une reponse arrivee avant son parent (rattrapage IMAP du plus recent au plus ancien)
// rejoint le fil du parent quand celui-ci arrive (lib/thread-links.ts, ss2i_merge_threads de la
// migration 008), en sequence comme en parallele, sans melanger deux proprietaires ni creer de
// fil pour un message deja present. Base de test : voir mcp-test-env.ts pour le lancement :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/thread-links.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { crmCompanies, db, mailboxes, mailboxThreads, messages, threadClients, threads } from "@db";
import { and, eq, inArray } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { storeMessageInThread } from "../lib/message-payload-parser";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

function raw(o: { id: string; subject: string; inReplyTo?: string; refs?: string[]; date: string }) {
	return [
		`From: Client <client@example.org>`,
		`To: moi@test.invalid`,
		`Subject: ${o.subject}`,
		`Date: ${o.date}`,
		`Message-ID: ${o.id}`,
		o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}` : null,
		o.refs?.length ? `References: ${o.refs.join(" ")}` : null,
		``,
		`corps ${o.id}`,
	].filter((l) => l !== null).join("\r\n");
}

async function ingest(f: Fixture, mailboxId: string, r: string, seen = false) {
	const parsed = await simpleParser(r);
	const decorated = {
		...parsed,
		createdAt: parsed.date,
		mailboxId,
		workspaceId: f.workspace.id,
		ownerId: f.user.id,
		headersJson: {},
		references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : null,
		seen,
		html: "",
		snippet: parsed.text?.slice(0, 100) ?? null,
	};
	const placed = await storeMessageInThread(parsed, decorated, { ownerId: f.user.id, workspaceId: f.workspace.id });
	return placed;
}

const threadsOf = async (ids: string[], ownerId: string) => {
	const rows = await db
		.select({ t: messages.threadId })
		.from(messages)
		.where(and(eq(messages.ownerId, ownerId), inArray(messages.messageId, ids)));
	return new Set(rows.map((r) => r.t));
};

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const tag = `${Date.now()}`;
	const id = (n: string) => `<${n}-${tag}@example.org>`;

	// 1. Rattrapage du plus recent au plus ancien : C (reponse a B), B (reponse a A), A.
	const [A, B, C] = [id("a"), id("b"), id("c")];
	await ingest(a, a.inbox.id, raw({ id: C, subject: "Re: Re: accord", inReplyTo: B, refs: [A, B], date: "Wed, 29 Oct 2026 10:00:00 +0000" }));
	await ingest(a, a.inbox.id, raw({ id: B, subject: "Re: accord", inReplyTo: A, refs: [A], date: "Tue, 28 Oct 2026 10:00:00 +0000" }), true);
	const beforeParent = await threadsOf([B, C], a.user.id);
	assert(beforeParent.size === 1, "B arrive apres C : C (son enfant) rejoint son fil");

	// Rattachement client et snooze poses sur le fil de C avant l'arrivee du parent.
	const [cRow] = await db.select().from(messages).where(and(eq(messages.ownerId, a.user.id), eq(messages.messageId, C)));
	await db.insert(crmCompanies).values({ id: 990001, name: "CLIENT TEST" }).onConflictDoNothing();
	await db.insert(threadClients).values({
		threadId: cRow.threadId, identityId: a.identity.id, crmCompanyId: 990001, ownerId: a.user.id,
		workspaceId: a.workspace.id, identityPublicId: a.identity.publicId, matchedBy: "domain",
		lastActivityAt: new Date(), detached: true,
	});
	const snooze = new Date(Date.now() + 86_400_000);
	await db.update(mailboxThreads).set({ snoozedUntil: snooze }).where(eq(mailboxThreads.threadId, cRow.threadId));

	const placedA = await ingest(a, a.inbox.id, raw({ id: A, subject: "accord", date: "Mon, 27 Oct 2026 10:00:00 +0000" }));
	const all = await threadsOf([A, B, C], a.user.id);
	assert(all.size === 1, "A arrive en dernier : A, B, C dans un seul fil");
	const target = [...all][0];
	assert(placedA?.merged === true && placedA.threadId === target, "storeMessageInThread signale la fusion et le fil final");

	const mts = await db.select().from(mailboxThreads).where(eq(mailboxThreads.threadId, target));
	assert(mts.length === 1 && mts[0].messageCount === 3 && mts[0].unreadCount === 2, `une ligne de liste, 3 messages dont 2 non lus (${JSON.stringify(mts.map((m) => [m.messageCount, m.unreadCount]))})`);
	assert(mts[0]?.subject === "Re: Re: accord", "sujet de la ligne = message le plus recent");
	assert(mts[0]?.snoozedUntil?.getTime() === snooze.getTime(), "snooze conserve");
	const tcs = await db.select().from(threadClients).where(eq(threadClients.threadId, target));
	assert(tcs.length === 1 && tcs[0].detached === true, "rattachement client deplace, detachement conserve");
	const [t] = await db.select().from(threads).where(eq(threads.id, target));
	assert(t && new Date(t.lastMessageDate!).toISOString() === "2026-10-29T10:00:00.000Z", "threads.last_message_date = plus recent");
	const orphans = await db
		.select({ id: threads.id })
		.from(threads)
		.where(and(eq(threads.ownerId, a.user.id)));
	assert(orphans.length === 2, `fils d'alice : fixture + conversation, aucun fil source restant (${orphans.length})`);

	// 2. Message deja present : rien n'est cree.
	const again = await ingest(a, a.inbox.id, raw({ id: B, subject: "Re: accord", inReplyTo: A, refs: [A], date: "Tue, 28 Oct 2026 10:00:00 +0000" }));
	const afterDup = await db.select({ id: threads.id }).from(threads).where(eq(threads.ownerId, a.user.id));
	assert(again === null && afterDup.length === 2, "doublon : null et aucun fil vide");

	// 3. Copie du meme message dans Envoyes : meme fil, une ligne par dossier.
	await ingest(a, a.sent.id, raw({ id: B, subject: "Re: accord", inReplyTo: A, refs: [A], date: "Tue, 28 Oct 2026 10:00:00 +0000" }), true);
	assert((await threadsOf([A, B, C], a.user.id)).size === 1, "copie dans Envoyes : meme fil");
	const rowsAfterCopy = await db.select().from(mailboxThreads).where(eq(mailboxThreads.threadId, target));
	assert(rowsAfterCopy.length === 2, "deux lignes de liste (inbox, sent) pour le fil");

	// 4. Cloisonnement : bob recoit les memes Message-ID, ses fils restent a lui.
	await ingest(b, b.inbox.id, raw({ id: C, subject: "Re: Re: accord", inReplyTo: B, refs: [A, B], date: "Wed, 29 Oct 2026 10:00:00 +0000" }));
	await ingest(b, b.inbox.id, raw({ id: A, subject: "accord", date: "Mon, 27 Oct 2026 10:00:00 +0000" }));
	const bobThreads = await threadsOf([A, C], b.user.id);
	assert(bobThreads.size === 1 && !bobThreads.has(target), "bob : A et C (refs) dans un fil a lui, jamais celui d'alice");
	assert((await threadsOf([A, B, C], a.user.id)).size === 1, "alice : inchangee apres bob");

	// 5. En parallele (rattrapage en concurrence 2 + temps reel) : parent et enfants a la fois.
	let ok = 0;
	const rounds = 15;
	for (let i = 0; i < rounds; i++) {
		const p = id(`p${i}`), r1 = id(`r${i}`), r2 = id(`s${i}`);
		await Promise.all([
			ingest(a, a.inbox.id, raw({ id: r2, subject: "Re: Re: x", inReplyTo: r1, refs: [p, r1], date: "Sat, 01 Nov 2026 12:00:00 +0000" })),
			ingest(a, a.inbox.id, raw({ id: p, subject: "x", date: "Sat, 01 Nov 2026 10:00:00 +0000" })),
			ingest(a, a.inbox.id, raw({ id: r1, subject: "Re: x", inReplyTo: p, refs: [p], date: "Sat, 01 Nov 2026 11:00:00 +0000" })),
		]);
		if ((await threadsOf([p, r1, r2], a.user.id)).size === 1) ok++;
	}
	assert(ok === rounds, `parallele : ${ok}/${rounds} conversations en un seul fil`);
	const empty = await db.execute(
		`select count(*)::int n from threads t where t.owner_id = '${a.user.id}' and not exists (select 1 from messages m where m.thread_id = t.id)` as any,
	);
	assert(Number((empty as any)[0]?.n) === 0, "aucun fil vide apres les fusions paralleles");

	// 6. Reparation : la fonction refuse de fusionner deux proprietaires.
	const [bobThread] = [...bobThreads];
	let refused = false;
	try {
		await db.execute(`select public.ss2i_merge_threads('${target}'::uuid, '{${bobThread}}'::uuid[])` as any);
	} catch {
		refused = true;
	}
	assert(refused, "ss2i_merge_threads refuse deux proprietaires");

	// 7. Archiver avec une duree de vie (docs/plans/archive-duree-de-vie.md) : une fusion annule
	//    l'echeance du fil fusionne (sens sur : le fil est conserve, rien ne part a la Corbeille).
	const [arch] = await db
		.insert(mailboxes)
		.values({ ownerId: a.user.id, workspaceId: a.workspace.id, identityId: a.identity.id, kind: "archive", name: "Archive", slug: "archive", isDefault: false })
		.returning();
	const [P, R] = [id("exp-p"), id("exp-r")];
	await ingest(a, arch.id, raw({ id: R, subject: "Re: echeance", inReplyTo: P, refs: [P], date: "Tue, 03 Nov 2026 11:00:00 +0000" }), true);
	const [rRow] = await db.select().from(messages).where(and(eq(messages.ownerId, a.user.id), eq(messages.messageId, R)));
	await db.update(mailboxThreads).set({ expiresAt: new Date(Date.now() + 30 * 86_400_000) }).where(eq(mailboxThreads.threadId, rRow.threadId));
	const placedP = await ingest(a, arch.id, raw({ id: P, subject: "echeance", date: "Tue, 03 Nov 2026 10:00:00 +0000" }), true);
	assert(placedP?.merged === true, "echeance : le parent arrive apres la reponse, les deux fils fusionnent");
	const expRows = await db.select().from(mailboxThreads).where(eq(mailboxThreads.threadId, placedP!.threadId));
	assert(expRows.length === 1 && expRows[0].messageCount === 2 && expRows[0].expiresAt === null, `echeance : ligne Archive du fil fusionne sans echeance (${expRows.map((r) => r.expiresAt)})`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
