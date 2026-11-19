// MCP courrier : archiver avec une duree de vie (Samuel le 19/11/2026). L'outil archive accepte
// expires_in (1m, 3m, 6m, 1y, 2y) ou expires_at (ISO), refuse une valeur invalide AVANT tout job
// (aucun Redis ici : une validation tardive echouerait sur la connexion, pas sur le message),
// et les fils rendus par list_threads portent expires_at. Plan :
// docs/plans/archive-duree-de-vie.md, etape 21. Lancement : voir mcp-test-env.ts.
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { handleRpcBody } from "../lib/mcp/rpc";
import { db, mailboxThreads } from "@db";
import { and, eq } from "drizzle-orm";
import type { ToolContext } from "../lib/mcp/tools";

async function main() {
	const a = await createUserFixture("expiry");
	const ctx: ToolContext = { userId: a.user.id, email: a.email, authType: "oauth", scopes: null };
	const call = (name: string, args: Record<string, unknown>) =>
		handleRpcBody(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<any>;
	const refused = async (args: Record<string, unknown>, pattern: RegExp, label: string) => {
		const r = await call("archive", { thread_ids: [a.thread.id], ...args });
		return assert(r?.result?.isError === true && pattern.test(r.result.content[0].text), `${label} -> ${r?.result?.content?.[0]?.text}`);
	};

	console.log("# schema de l'outil");
	const list = (await handleRpcBody(ctx, { jsonrpc: "2.0", id: 0, method: "tools/list" })) as any;
	const tool = list.result.tools.find((t: any) => t.name === "archive");
	assert(tool?.inputSchema?.properties?.expires_in?.enum?.join() === "1m,3m,6m,1y,2y", "archive : expires_in enum 1m,3m,6m,1y,2y");
	assert(tool?.inputSchema?.properties?.expires_at?.type === "string", "archive : expires_at (ISO)");
	assert(!tool?.inputSchema?.required?.includes("expires_in"), "archive : la duree reste optionnelle");

	console.log("# valeurs refusees avant tout job");
	await refused({ expires_in: "5y" }, /expires_in/, "expires_in inconnu");
	await refused({ expires_at: "pas une date" }, /expires_at/, "expires_at illisible");
	await refused({ expires_at: new Date(Date.now() - 86_400_000).toISOString() }, /expires_at/, "expires_at passe");
	await refused({ expires_at: "2099-01-01T00:00:00Z" }, /expires_at/, "expires_at a plus de dix ans");
	await refused({ expires_in: "1m", expires_at: new Date(Date.now() + 86_400_000 * 40).toISOString() }, /not both/, "les deux ensemble");

	console.log("# expires_at dans la projection d'un fil");
	const before = await call("list_threads", {});
	const row0 = before.result.structuredContent.items.find((t: any) => t.thread_id === a.thread.id);
	assert(row0 && row0.expires_at === null, "fil sans echeance : expires_at null");
	const at = new Date(Date.UTC(2027, 5, 1, 0, 0, 0));
	await db
		.update(mailboxThreads)
		.set({ expiresAt: at })
		.where(and(eq(mailboxThreads.threadId, a.thread.id), eq(mailboxThreads.mailboxId, a.inbox.id)));
	const after = await call("list_threads", {});
	const row1 = after.result.structuredContent.items.find((t: any) => t.thread_id === a.thread.id);
	assert(row1?.expires_at === at.toISOString(), `fil avec echeance : expires_at ${row1?.expires_at}`);
}

main()
	.then(() => {
		console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
		process.exit(process.exitCode ?? 0);
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
