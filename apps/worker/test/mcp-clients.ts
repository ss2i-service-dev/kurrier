// Section « Clients » des boites pro : rattachement d'un fil a une societe de la CRM a
// partir du cache d'adresses (lib/crm/link-thread.ts, sans appel CRM : pas de jeton),
// detachement manuel conserve par le rattrapage, et cloisonnement des outils MCP
// list_clients et list_client_threads (un utilisateur ne voit pas les clients ni les
// fils d'un autre). Voir mcp-test-env.ts pour le lancement :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/mcp-clients.ts
import "./crm-test-env";
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { crmCompanies, crmEmailMatches, db, mailboxThreads, messages, threadClients } from "@db";
import { and, eq } from "drizzle-orm";
import { backfillIdentity, linkThread, readBackfillState } from "../lib/crm/link-thread";
import { clientsForThreads, listClientThreads, listClients } from "../lib/mcp/access";
import { handleRpcBody } from "../lib/mcp/rpc";
import type { ToolContext } from "../lib/mcp/tools";

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const ctxA: ToolContext = { userId: a.user.id, email: a.email, authType: "oauth", scopes: null };
	const ctxB: ToolContext = { userId: b.user.id, email: b.email, authType: "oauth", scopes: null };

	// Cache d'adresses pret : julie -> ALCHIMIE (885), paul -> DELVIE (7), bob -> rien.
	await db.insert(crmCompanies).values([
		{ id: 885, name: "ALCHIMIE", ebpCustomerId: "CL01180" },
		{ id: 7, name: "SARL DELVIE", ebpCustomerId: "CL01208" },
	]).onConflictDoNothing();
	await db.insert(crmEmailMatches).values([
		{ email: "julie@espacealchimie.example", matched: true, matchedBy: "domain", crmCompanyId: 885 },
		{ email: "paul@delvie.example", matched: true, matchedBy: "email", crmCompanyId: 7 },
		{ email: "nobody@gmail.example", matched: false },
	]).onConflictDoNothing();

	// Le fil de A recoit deux messages exterieurs (un client chacun) et un message interne.
	const addMessage = async (f: typeof a, from: string, to: string, mailboxId: string) => {
		const [m] = await db
			.insert(messages)
			.values({
				ownerId: f.user.id,
				workspaceId: f.workspace.id,
				mailboxId,
				threadId: f.thread.id,
				messageId: `<${from}-${Date.now()}-${Math.random()}@test.invalid>`,
				subject: "s",
				text: "t",
				html: "<p>t</p>",
				from: { value: [{ address: from, name: "" }], html: "", text: "" },
				to: { value: [{ address: to, name: "" }], html: "", text: "" },
				date: new Date(),
				seen: true,
			})
			.returning();
		return m;
	};
	await addMessage(a, "julie@espacealchimie.example", a.email, a.inbox.id);
	await addMessage(a, a.email, "paul@delvie.example", a.sent.id);
	await addMessage(a, "other@test.invalid", a.email, a.inbox.id);
	await db.insert(mailboxThreads).values({
		threadId: a.thread.id, mailboxId: a.sent.id, ownerId: a.user.id, identityId: a.identity.id,
		identityPublicId: a.identity.publicId, mailboxSlug: "sent", subject: "s", previewText: "t",
		lastActivityAt: new Date(), firstMessageAt: new Date(), messageCount: 1, unreadCount: 0, workspaceId: a.workspace.id,
	});

	console.log("# rattachement d'un fil (cache seulement, pas de CRM)");
	const r = await linkThread(a.thread.id, a.identity.id);
	assert(!r.skipped && r.externalAddresses === 2, `2 adresses exterieures (julie, paul ; sender-alice est interne ici), got ${r.externalAddresses}`);
	assert(r.companies.join(",") === "7,885", `fil de A rattache a DELVIE et ALCHIMIE: ${r.companies.join(",")}`);
	const rowsA = await db.select().from(threadClients).where(eq(threadClients.threadId, a.thread.id));
	assert(rowsA.length === 2 && rowsA.every((x) => x.ownerId === a.user.id && x.identityId === a.identity.id), "2 lignes thread_clients, owner et identite de A");
	const again = await linkThread(a.thread.id, a.identity.id);
	assert(again.companies.length === 2 && (await db.select().from(threadClients).where(eq(threadClients.threadId, a.thread.id))).length === 2, "rejouer ne duplique pas");

	console.log("# detachement manuel conserve");
	await db.update(threadClients).set({ detached: true }).where(and(eq(threadClients.threadId, a.thread.id), eq(threadClients.crmCompanyId, 885)));
	await linkThread(a.thread.id, a.identity.id);
	const afterDetach = await db.select().from(threadClients).where(and(eq(threadClients.threadId, a.thread.id), eq(threadClients.crmCompanyId, 885)));
	assert(afterDetach.length === 1 && afterDetach[0].detached === true, "la ligne detachee reste detachee apres un nouveau rattachement");
	const clientsA = await listClients({ userId: a.user.id, identityId: a.identity.id, limit: 50 });
	assert(clientsA.length === 1 && clientsA[0].companyId === 7 && Number(clientsA[0].threadCount) === 1, "listClients(A) : DELVIE seulement (ALCHIMIE detache)");
	await db.update(threadClients).set({ detached: false }).where(eq(threadClients.threadId, a.thread.id));

	console.log("# rattrapage d'une identite");
	const bf = await backfillIdentity(a.identity.id);
	assert(!bf.skipped && bf.processed === 1 && bf.linked === 1, `backfill A: processed=${bf.processed} linked=${bf.linked}`);
	const state = await readBackfillState(a.identity.id);
	assert(!!state.doneAt && state.processed === 1, "curseur et doneAt ecrits dans identities.meta.ss2iCrmLink");
	const bfB = await backfillIdentity(b.identity.id);
	assert(!bfB.skipped && bfB.processed === 1 && bfB.linked === 0, "backfill B : aucun client (sender-bob inconnu du cache, pas de CRM)");

	console.log("# identite non pro : rien");
	const [nonPro] = await db.select().from(messages).where(eq(messages.id, b.message.id));
	assert(!!nonPro, "fixture B lisible");
	const resNonPro = await linkThread(b.thread.id, b.identity.id);
	assert(!resNonPro.skipped, "B est pro (test.invalid) dans ce test");

	console.log("# cloisonnement de la couche d'acces");
	assert((await listClients({ userId: b.user.id, identityId: a.identity.id, limit: 50 })).length === 0, "listClients(B, identite A) vide");
	assert((await listClientThreads({ userId: b.user.id, identityId: a.identity.id, companyId: 7, limit: 10, offset: 0 })).length === 0, "listClientThreads(B, identite A) vide");
	assert((await listClientThreads({ userId: a.user.id, identityId: a.identity.id, companyId: 7, limit: 10, offset: 0 })).length === 1, "listClientThreads(A) : le fil de A, une seule ligne malgre inbox + sent");
	assert((await clientsForThreads(b.user.id, [a.thread.id])).size === 0, "clientsForThreads(B, fil A) vide");
	assert((await clientsForThreads(a.user.id, [a.thread.id])).get(a.thread.id)?.length === 2, "clientsForThreads(A, fil A) : 2 clients");

	console.log("# JSON-RPC");
	const call = (ctx: ToolContext, name: string, args: Record<string, unknown>) =>
		handleRpcBody(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<any>;
	const list = (await handleRpcBody(ctxB, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
	const names = (list?.result?.tools ?? []).map((t: any) => t.name);
	assert(names.includes("list_clients") && names.includes("list_client_threads"), "tools/list expose list_clients et list_client_threads");
	const lcB = await call(ctxB, "list_clients", { identity: a.email });
	assert(lcB?.result?.isError === true && /Identity not found/.test(lcB.result.content[0].text), "list_clients(identite A) as B -> isError");
	const lcBown = await call(ctxB, "list_clients", {});
	assert(lcBown?.result?.isError !== true && lcBown.result.structuredContent.items.length === 0, "list_clients as B : aucun client");
	const lcA = await call(ctxA, "list_clients", {});
	assert(lcA?.result?.isError !== true && lcA.result.structuredContent.items.length === 2, "list_clients as A : 2 clients");
	assert(lcA.result.structuredContent.items.every((c: any) => c.thread_count === 1 && typeof c.name === "string"), "list_clients : nom et nombre de fils");
	const lcAq = await call(ctxA, "list_clients", { query: "delv" });
	assert(lcAq.result.structuredContent.items.length === 1 && lcAq.result.structuredContent.items[0].client_id === 7, "list_clients query filtre sur le nom");
	const ltB = await call(ctxB, "list_client_threads", { client_id: 7 });
	assert(ltB?.result?.isError !== true && ltB.result.structuredContent.items.length === 0, "list_client_threads(7) as B : vide");
	const ltA = await call(ctxA, "list_client_threads", { client_id: 7 });
	assert(ltA?.result?.isError !== true && ltA.result.structuredContent.items.length === 1 && ltA.result.structuredContent.items[0].thread_id === a.thread.id, "list_client_threads(7) as A : le fil de A");
	const ltMissing = await call(ctxA, "list_client_threads", {});
	assert(ltMissing?.result?.isError === true, "list_client_threads sans client_id -> isError");
	const threadsA = await call(ctxA, "list_threads", {});
	const itemA = threadsA.result.structuredContent.items.find((t: any) => t.thread_id === a.thread.id);
	assert(Array.isArray(itemA?.clients) && itemA.clients.length === 2, "list_threads as A porte les clients du fil");
	const getA = await call(ctxA, "get_thread", { thread_id: a.thread.id });
	assert(Array.isArray(getA.result.structuredContent.clients) && getA.result.structuredContent.clients.some((c: any) => c.name === "ALCHIMIE"), "get_thread as A porte les clients");
	const threadsB = await call(ctxB, "list_threads", {});
	assert(threadsB.result.structuredContent.items.every((t: any) => t.clients === undefined), "list_threads as B : aucun client");

	await expectThrow(() => listClientThreads({ userId: a.user.id, identityId: "not-a-uuid", companyId: 7, limit: 1, offset: 0 }), /invalid input syntax|uuid/i, "identite malformee refusee par Postgres");
}

main()
	.then(() => {
		console.log(process.exitCode ? "FAILED" : "all mcp-clients tests passed");
		process.exit(process.exitCode ?? 0);
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
