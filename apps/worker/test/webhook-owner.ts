// Webhooks cloisonnes par proprietaire et par workspace (releve au tri de l'amont v4.4.1,
// GHSA-cvh9-93mg-xvc9, commits 0a6cbc5 et bef67fe).
// 1. Envoi : un collegue qui voit une identite partagee (ou qui y a cree un dossier) ne recoit
//    pas le courrier entrant de cette identite par un webhook a lui ; seul le proprietaire de
//    l'identite le recoit.
// 2. API : une cle API n'atteint que les webhooks et les identites de SON workspace, meme pour
//    un utilisateur qui a plusieurs workspaces.
// Aucun envoi reel : les webhooks d'envoi visent 127.0.0.1 (refuse par safe-http, l'echec est
// journalise avec l'URL, c'est ce qui est observe) ; ceux de l'API sont desactives.
// Base de test comme mcp-isolation.ts (voir mcp-test-env.ts) :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55471/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/webhook-owner.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, toNodeListener } from "h3";
import {
	apiKeys,
	createSecretAdmin,
	db,
	identities,
	mailboxes,
	users,
	webhooks,
	workspaceMembers,
	workspaces,
} from "@db";
import { eq } from "drizzle-orm";
import { processWebhook } from "../lib/webhooks/message.received";
import listHooks from "../server/routes/api/kurrier/webhooks/index.get";
import createHook from "../server/routes/api/kurrier/webhooks/index.post";
import getHook from "../server/routes/api/kurrier/webhooks/[id].get";
import patchHook from "../server/routes/api/kurrier/webhooks/[id].patch";
import deleteHook from "../server/routes/api/kurrier/webhooks/[id].delete";

// URLs des webhooks tentes pour ce message (processWebhook journalise chaque echec d'envoi).
async function attempted(message: any): Promise<string[]> {
	const urls: string[] = [];
	const orig = console.error;
	console.error = (...args: any[]) => {
		const m = String(args[0]).match(/Error sending webhook to (\S+): ?$/);
		if (m) urls.push(m[1]);
		else orig(...args);
	};
	try {
		await processWebhook({ message, rawEmail: "raw" });
	} finally {
		console.error = orig;
	}
	return urls;
}

async function apiKeyFor(ownerId: string, workspaceId: string, tag: string) {
	const rawKey = `wh${tag}${Date.now() % 100000}.${"k".repeat(28)}${tag.slice(0, 1)}xyz`;
	const [prefix] = rawKey.split(".");
	const secret = await createSecretAdmin({
		ownerId,
		workspaceId,
		name: `api-${tag}-${Date.now()}`,
		value: JSON.stringify({ rawKey }),
	});
	await db.insert(apiKeys).values({
		ownerId,
		workspaceId,
		name: `key-${tag}`,
		secretId: secret.id,
		keyPrefix: prefix,
		keyLast4: rawKey.slice(-4),
		scopes: ["emails:receive"],
	} as any);
	return rawKey;
}

async function main() {
	console.log("# envoi : seul le proprietaire de l'identite recoit le courrier entrant");
	const a = await createUserFixture("wh-a");
	const [b] = await db
		.insert(users)
		.values({ email: `wh-b-${Date.now()}@test.invalid`, passwordHash: "x" })
		.returning();
	await db.insert(workspaceMembers).values({ workspaceId: a.workspace.id, userId: b.id, role: "member" });
	const ownerUrl = `http://127.0.0.1:9/owner-${a.user.id}`;
	const colleagueUrl = `http://127.0.0.1:9/colleague-${b.id}`;
	// Webhook du collegue sur l'identite de A, dans le workspace de A : ce qu'addWebhook
	// acceptait pour une identite partagee (et qui reste en base pour les webhooks deja crees).
	await db.insert(webhooks).values([
		{ ownerId: a.user.id, workspaceId: a.workspace.id, identityId: a.identity.id, url: ownerUrl, events: ["message.received"], enabled: true },
		{ ownerId: b.id, workspaceId: a.workspace.id, identityId: a.identity.id, url: colleagueUrl, events: ["message.received"], enabled: true },
	] as any);

	const inInbox = await attempted(a.message);
	assert(inInbox.includes(ownerUrl), "inbox: the identity owner's webhook is called");
	assert(!inInbox.includes(colleagueUrl), "inbox: a colleague's webhook on the shared identity is not called");

	// Dossier cree par le collegue dans l'identite partagee : la boite a pour proprietaire le
	// collegue (mailbox.ts, ajout de dossier). Filtrer sur mailbox.ownerId (amont) ouvrirait
	// ce dossier a son webhook ; c'est le proprietaire de l'identite qui compte.
	const [folderB] = await db
		.insert(mailboxes)
		.values({
			ownerId: b.id,
			workspaceId: a.workspace.id,
			identityId: a.identity.id,
			kind: "custom",
			name: "Dossier B",
			slug: `dossier-b-${Date.now()}`,
			isDefault: false,
			metaData: {},
		})
		.returning();
	const inFolderB = await attempted({ ...a.message, mailboxId: folderB.id });
	assert(inFolderB.includes(ownerUrl), "colleague's folder: the identity owner's webhook is still called");
	assert(!inFolderB.includes(colleagueUrl), "colleague's folder: the colleague's webhook is not called");

	console.log("# API : une cle n'atteint que les webhooks et identites de son workspace");
	const k = await createUserFixture("wh-k");
	const [w2] = await db.insert(workspaces).values({ ownerId: k.user.id, name: "ws-wh-k2" }).returning();
	const [i2] = await db
		.insert(identities)
		.values({ ownerId: k.user.id, workspaceId: w2.id, kind: "email", value: `k2-${Date.now()}@test.invalid`, status: "verified" })
		.returning();
	const key1 = await apiKeyFor(k.user.id, k.workspace.id, "one");
	const key2 = await apiKeyFor(k.user.id, w2.id, "two");
	const publicUrl = "http://93.184.216.34/hook";
	const [h1] = await db
		.insert(webhooks)
		.values({ ownerId: k.user.id, workspaceId: k.workspace.id, identityId: k.identity.id, url: publicUrl, events: ["message.received"], enabled: false } as any)
		.returning();
	const [h2] = await db
		.insert(webhooks)
		.values({ ownerId: k.user.id, workspaceId: w2.id, identityId: i2.id, url: publicUrl, events: ["message.received"], enabled: false } as any)
		.returning();

	const router = createRouter()
		.get("/webhooks", listHooks)
		.post("/webhooks", createHook)
		.get("/webhooks/:id", getHook)
		.patch("/webhooks/:id", patchHook)
		.delete("/webhooks/:id", deleteHook);
	const app = createApp();
	app.use(router);
	const server = createServer(toNodeListener(app));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = async (method: string, path: string, key: string, body?: unknown) => {
		const res = await fetch(base + path, {
			method,
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, json: (await res.json().catch(() => null)) as any };
	};
	const ids = (r: { json: any }) => (r.json?.data ?? []).map((h: any) => h.id);

	const list1 = await call("GET", "/webhooks", key1);
	assert(list1.status === 200 && ids(list1).includes(h1.id), "list: key of W1 sees the W1 webhook");
	assert(!ids(list1).includes(h2.id), "list: key of W1 does not see the W2 webhook of the same owner");

	assert((await call("GET", `/webhooks/${h1.id}`, key1)).status === 200, "get: key of W1 reads the W1 webhook");
	assert((await call("GET", `/webhooks/${h2.id}`, key1)).status === 404, "get: key of W1 cannot read the W2 webhook");

	const patchOther = await call("PATCH", `/webhooks/${h2.id}`, key1, { description: "pris par W1" });
	assert(patchOther.status === 404, `patch: key of W1 cannot change the W2 webhook (${patchOther.status})`);
	const [h2After] = await db.select().from(webhooks).where(eq(webhooks.id, h2.id));
	assert(h2After?.description !== "pris par W1", "patch: the W2 webhook is unchanged");

	const patchOwn = await call("PATCH", `/webhooks/${h1.id}`, key1, { description: "ok" });
	assert(patchOwn.status === 200 && patchOwn.json?.data?.description === "ok", "patch: key of W1 changes the W1 webhook");
	const moveToW2 = await call("PATCH", `/webhooks/${h1.id}`, key1, { identityId: i2.id });
	assert(moveToW2.status === 403, `patch: key of W1 cannot point a webhook at a W2 identity (${moveToW2.status})`);
	const [h1After] = await db.select().from(webhooks).where(eq(webhooks.id, h1.id));
	assert(h1After?.identityId === k.identity.id && h1After?.workspaceId === k.workspace.id, "patch: the W1 webhook keeps its identity and workspace");

	const createOther = await call("POST", "/webhooks", key1, { url: publicUrl, events: ["message.received"], identityId: i2.id, enabled: false });
	assert(createOther.status === 403, `create: key of W1 cannot create a webhook on a W2 identity (${createOther.status})`);
	const createOwn = await call("POST", "/webhooks", key1, { url: publicUrl, events: ["message.received"], identityId: k.identity.id, enabled: false });
	assert(
		createOwn.status === 200 && createOwn.json?.data?.workspaceId === k.workspace.id,
		`create: key of W1 creates a webhook on a W1 identity (${createOwn.status})`,
	);

	const deleteOther = await call("DELETE", `/webhooks/${h2.id}`, key1);
	assert(deleteOther.status === 404, `delete: key of W1 cannot delete the W2 webhook (${deleteOther.status})`);
	const [h2Still] = await db.select().from(webhooks).where(eq(webhooks.id, h2.id));
	assert(!!h2Still, "delete: the W2 webhook still exists");
	assert((await call("DELETE", `/webhooks/${h2.id}`, key2)).status === 200, "delete: key of W2 deletes the W2 webhook");

	server.close();
	console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
