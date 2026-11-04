// Section « Clients » : rattachement MANUEL d'un fil a une societe (OI 10270). Une ligne
// matched_by = "manual" n'est ni retiree ni requalifiee par crm-link (fil, rattrapage),
// survit a la fusion des fils (ss2i_merge_threads, migration 009), se detache et se
// re-rattache ; Annuler rend l'etat d'avant ; dossier « Sans client » (thread_crm_scans) ;
// outils MCP search_crm_companies, link_thread_to_client, unlink_thread_from_client
// cloisonnes par utilisateur. Voir mcp-test-env.ts pour le lancement :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55441/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/client-manual-link.ts
import "./crm-test-env";
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { crmCompanies, crmEmailMatches, db, mailboxThreads, messages, threadClients, threadCrmScans, threads } from "@db";
import { and, eq, sql } from "drizzle-orm";
import { attachThreadsToCompany, detachThreadsFromCompany, emailForCompanyQuery, orphanThreadsPage, restoreThreadLinks } from "@common/server-client-link";
import { backfillIdentity, linkThread } from "../lib/crm/link-thread";
import { handleRpcBody } from "../lib/mcp/rpc";
import type { ToolContext } from "../lib/mcp/tools";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

// Un fil de plus dans l'Inbox de f, un message de `from`.
async function newThread(f: Fixture, from: string, at = new Date()) {
	const [thread] = await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: at }).returning();
	await db.insert(messages).values({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		mailboxId: f.inbox.id,
		threadId: thread.id,
		messageId: `<${Math.random()}-${Date.now()}@test.invalid>`,
		subject: `de ${from}`,
		text: "t",
		html: "<p>t</p>",
		from: { value: [{ address: from, name: "" }], html: "", text: "" },
		to: { value: [{ address: f.email, name: "" }], html: "", text: "" },
		date: at,
		seen: true,
	});
	await db.insert(mailboxThreads).values({
		threadId: thread.id, mailboxId: f.inbox.id, ownerId: f.user.id, identityId: f.identity.id,
		identityPublicId: f.identity.publicId, mailboxSlug: "inbox", subject: `de ${from}`, previewText: "t",
		lastActivityAt: at, firstMessageAt: at, messageCount: 1, unreadCount: 0, workspaceId: f.workspace.id,
	});
	return thread.id;
}

const row = async (threadId: string, identityId: string, companyId: number) =>
	(await db.select().from(threadClients).where(and(eq(threadClients.threadId, threadId), eq(threadClients.identityId, identityId), eq(threadClients.crmCompanyId, companyId))))[0];

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const identA = { id: a.identity.id, ownerId: a.user.id, workspaceId: a.workspace.id, publicId: a.identity.publicId };
	const ctxA: ToolContext = { userId: a.user.id, email: a.email, authType: "oauth", scopes: null };
	const ctxB: ToolContext = { userId: b.user.id, email: b.email, authType: "oauth", scopes: null };
	await db.insert(crmCompanies).values([
		{ id: 885, name: "ALCHIMIE", ebpCustomerId: "CL01180" },
		{ id: 7, name: "SARL DELVIE", ebpCustomerId: "CL01208" },
		{ id: 4242, name: "PROSPECT SANS FIL", ebpCustomerId: null },
	]).onConflictDoNothing();
	await db.insert(crmEmailMatches).values([
		{ email: "julie@espacealchimie.example", matched: true, matchedBy: "domain", crmCompanyId: 885 },
		{ email: "paul@delvie.example", matched: true, matchedBy: "email", crmCompanyId: 7 },
		{ email: "inconnu@gmail.example", matched: false },
	]).onConflictDoNothing();

	const tJulie = await newThread(a, "julie@espacealchimie.example", new Date(Date.now() - 3000));
	const tGmail = await newThread(a, "inconnu@gmail.example", new Date(Date.now() - 2000));
	const tNoreply = await newThread(a, "no-reply@service.example", new Date(Date.now() - 1000));

	console.log("# rattachement manuel");
	const prev = await attachThreadsToCompany(identA, [tGmail], 4242);
	assert(prev.length === 1 && prev[0].state === "absent", "etat precedent : absent");
	let r = await row(tGmail, a.identity.id, 4242);
	assert(r?.matchedBy === "manual" && r.detached === false && r.ownerId === a.user.id && r.workspaceId === a.workspace.id, "ligne manual, non detachee, owner et workspace de l'identite");

	console.log("# crm-link ne retire ni ne requalifie une ligne manuelle");
	await linkThread(tGmail, a.identity.id);
	r = await row(tGmail, a.identity.id, 4242);
	assert(r?.matchedBy === "manual" && !r.detached, "linkThread (aucune societe par les adresses) garde la ligne manuelle");
	await attachThreadsToCompany(identA, [tJulie], 885);
	await linkThread(tJulie, a.identity.id);
	r = await row(tJulie, a.identity.id, 885);
	assert(r?.matchedBy === "manual", "adresses menant aussi a la societe : matched_by reste manual");
	const bf = await backfillIdentity(a.identity.id);
	assert(!bf.skipped, `rattrapage : processed=${bf.processed}`);
	assert((await row(tGmail, a.identity.id, 4242))?.matchedBy === "manual", "le rattrapage (LINK_RULES_VERSION) garde la ligne manuelle");

	console.log("# detacher, re-rattacher, annuler");
	assert((await detachThreadsFromCompany(identA, [tGmail], 4242)) === 1, "detachement d'une ligne manuelle");
	await linkThread(tGmail, a.identity.id);
	r = await row(tGmail, a.identity.id, 4242);
	assert(r?.detached === true, "la ligne manuelle detachee reste detachee apres crm-link");
	const prev2 = await attachThreadsToCompany(identA, [tGmail], 4242);
	r = await row(tGmail, a.identity.id, 4242);
	assert(prev2[0].state === "detached" && r?.detached === false && r.matchedBy === "manual", "re-rattacher reactive la ligne detachee");
	await restoreThreadLinks(identA, 4242, prev2);
	assert((await row(tGmail, a.identity.id, 4242))?.detached === true, "Annuler remet la ligne detachee");
	await linkThread(tJulie, a.identity.id); // ligne automatique domaine -> 885 deja manual ; 7 jamais
	const tPaul = await newThread(a, "paul@delvie.example");
	await linkThread(tPaul, a.identity.id);
	const prev3 = await attachThreadsToCompany(identA, [tPaul], 7);
	assert(prev3[0].state === "linked" && prev3[0].matchedBy === "email" && (await row(tPaul, a.identity.id, 7))?.matchedBy === "manual", "ligne automatique passee en manual");
	await restoreThreadLinks(identA, 7, prev3);
	assert((await row(tPaul, a.identity.id, 7))?.matchedBy === "email", "Annuler rend le matched_by automatique");
	const tNew = await newThread(a, "inconnu@gmail.example");
	const prev4 = await attachThreadsToCompany(identA, [tNew], 885);
	await restoreThreadLinks(identA, 885, prev4);
	assert(!(await row(tNew, a.identity.id, 885)), "Annuler retire la ligne creee");

	console.log("# dossier « Sans client »");
	for (const t of [tJulie, tGmail, tNoreply, tPaul, tNew]) await linkThread(t, a.identity.id);
	const scans = await db.select().from(threadCrmScans).where(eq(threadCrmScans.identityId, a.identity.id));
	const ext = new Map(scans.map((s) => [s.threadId, s.externalAddresses]));
	assert(ext.get(tNoreply) === 0 && ext.get(tGmail) === 1, "scan : no-reply = 0 adresse exterieure, gmail = 1");
	let orphans = await orphanThreadsPage(a.identity.id, 1, 50);
	let ids = orphans.threads.map((t) => t.threadId);
	assert(ids.includes(tGmail) && ids.includes(tNew), "fils sans client (dont le fil detache) dans « Sans client »");
	assert(!ids.includes(tNoreply) && !ids.includes(tJulie) && !ids.includes(tPaul), "ni automate, ni fils rattaches");
	assert(orphans.total === ids.length, `total = ${orphans.total}`);
	assert(ids.indexOf(tNew) < ids.indexOf(tGmail), "plus recent d'abord");
	await attachThreadsToCompany(identA, [tNew], 4242);
	orphans = await orphanThreadsPage(a.identity.id, 1, 50);
	assert(!orphans.threads.some((t) => t.threadId === tNew), "un fil rattache sort aussitot de « Sans client »");
	const empty = await orphanThreadsPage(b.identity.id, 3, 50);
	assert(empty.threads.length === 0 && empty.total === 0, "« Sans client » d'une autre identite vide, page hors limite sans erreur");

	console.log("# fusion des fils (ss2i_merge_threads)");
	const tFrag = await newThread(a, "inconnu@gmail.example");
	await attachThreadsToCompany(identA, [tFrag], 7);
	await linkThread(tFrag, a.identity.id);
	const tTarget = await newThread(a, "paul@delvie.example");
	await linkThread(tTarget, a.identity.id); // 7 en email (automatique)
	await db.execute(sql`select ss2i_merge_threads(${tTarget}::uuid, array[${tFrag}::uuid])`);
	r = await row(tTarget, a.identity.id, 7);
	assert(r?.matchedBy === "manual", `fusion : le rattachement manuel du fragment reste manuel (${r?.matchedBy})`);
	await linkThread(tTarget, a.identity.id);
	assert((await row(tTarget, a.identity.id, 7))?.matchedBy === "manual", "et crm-link ne le requalifie pas apres la fusion");
	const merged = await db.select().from(threadCrmScans).where(eq(threadCrmScans.threadId, tFrag));
	assert(merged.length === 0, "scan du fragment fusionne retire");

	console.log("# outils MCP");
	const call = (ctx: ToolContext, name: string, args: Record<string, unknown>) =>
		handleRpcBody(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<any>;
	const list = (await handleRpcBody(ctxA, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
	const names = (list?.result?.tools ?? []).map((t: any) => t.name);
	assert(["search_crm_companies", "link_thread_to_client", "unlink_thread_from_client"].every((n) => names.includes(n)), "tools/list expose les trois outils");
	const s = await call(ctxA, "search_crm_companies", { query: "prospect" });
	assert(s?.result?.isError !== true && s.result.structuredContent.items.some((c: any) => c.client_id === 4242), "search_crm_companies : societe connue sans fil (CRM non configuree)");
	const tB = await newThread(b, "inconnu@gmail.example");
	const lB = await call(ctxB, "link_thread_to_client", { thread_ids: [tGmail], client_id: 4242 });
	assert(lB?.result?.isError === true && !(await row(tGmail, b.identity.id, 4242)), "B ne rattache pas un fil de A");
	const lBa = await call(ctxB, "link_thread_to_client", { thread_ids: [tB], client_id: 4242, identity: a.email });
	assert(lBa?.result?.isError === true && /Identity not found/.test(lBa.result.content[0].text), "B ne vise pas l'identite de A");
	const lA = await call(ctxA, "link_thread_to_client", { thread_ids: [tGmail, tB], client_id: 4242 });
	const sc = lA?.result?.structuredContent;
	assert(lA?.result?.isError !== true && sc.linked === 1 && sc.ignored.length === 1 && sc.ignored[0] === tB, "A rattache son fil, le fil de B est ignore");
	assert(!(await row(tB, a.identity.id, 4242)) && !(await row(tB, b.identity.id, 4242)), "aucune ligne pour le fil de B");
	const unknown = await call(ctxA, "link_thread_to_client", { thread_ids: [tGmail], client_id: 999999 });
	assert(unknown?.result?.isError === true && /search_crm_companies/.test(unknown.result.content[0].text), "client_id inconnu -> isError");
	const u = await call(ctxA, "unlink_thread_from_client", { thread_ids: [tGmail], client_id: 4242 });
	assert(u?.result?.isError !== true && u.result.structuredContent.detached === 1 && (await row(tGmail, a.identity.id, 4242))?.detached === true, "unlink_thread_from_client detache");
	const lc = await call(ctxA, "list_clients", { query: "prospect" });
	assert(lc.result.structuredContent.items.some((c: any) => c.client_id === 4242), "la societe rattachee a la main apparait dans list_clients");

	console.log("# saisie -> adresse pour email-match");
	assert(emailForCompanyQuery("Julie@Acme.fr") === "julie@acme.fr", "adresse");
	assert(emailForCompanyQuery("https://www.acme.fr/contact") === "contact@acme.fr" && emailForCompanyQuery("@acme.fr") === "contact@acme.fr", "domaine, URL");
	assert(emailForCompanyQuery("Acme SARL") === null, "nom : pas d'adresse");
}

main()
	.then(() => {
		console.log(process.exitCode ? "FAILED" : "all client-manual-link tests passed");
		process.exit(process.exitCode ?? 0);
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
