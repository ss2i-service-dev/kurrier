// Garde-fous de l'envoi (lib/send-guards.ts) : message d'origine et pieces jointes d'un autre
// workspace refuses, ceux de l'expediteur acceptes. Lancement comme mcp-isolation.ts (voir
// mcp-test-env.ts) :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/send-guards.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { allowedAttachmentKeys, originalUsableBy } from "../lib/send-guards";
import { db, workspaceMembers } from "@db";

async function main() {
	const a = await createUserFixture("guard-a");
	const b = await createUserFixture("guard-b");
	const ctxA = { workspaceId: a.workspace.id, identityOwnerId: a.user.id, senderUserId: a.user.id };

	console.log("# message d'origine");
	assert(originalUsableBy(a.message, a.inbox), "A's own message usable by A's identity");
	assert(!originalUsableBy(b.message, a.inbox), "B's message refused for A's identity");
	assert(!originalUsableBy(null, a.inbox), "missing message refused");

	console.log("# pieces jointes");
	const own = `private/${a.user.id}/${crypto.randomUUID()}/upload.pdf`;
	const ok = await allowedAttachmentKeys([own, a.attachment.path], ctxA);
	assert(ok.has(own), "A's own upload allowed");
	assert(ok.has(a.attachment.path), "attachment of A's message allowed");

	const foreign = await allowedAttachmentKeys([b.attachment.path, `private/${b.user.id}/x/y.pdf`], ctxA);
	assert(foreign.size === 0, "B's attachment and B's upload prefix refused for A");

	const tricky = await allowedAttachmentKeys(
		[`private/${a.user.id}/../${b.user.id}/x.pdf`, `private/${a.user.id}//x.pdf`, `eml/${b.user.id}/x.eml`],
		ctxA,
	);
	assert(tricky.size === 0, "traversal, empty segment and other prefixes refused");

	// Expediteur declare B sur une identite de A : B n'est pas membre du workspace de A.
	const spoofed = await allowedAttachmentKeys([`private/${b.user.id}/x/y.pdf`], {
		...ctxA,
		senderUserId: b.user.id,
	});
	assert(spoofed.size === 0, "upload prefix of a non-member sender refused");

	// B devient membre du workspace de A : ses depots sont acceptes pour une identite de A.
	await db.insert(workspaceMembers).values({ workspaceId: a.workspace.id, userId: b.user.id, role: "member" });
	const member = await allowedAttachmentKeys([`private/${b.user.id}/x/y.pdf`], {
		...ctxA,
		senderUserId: b.user.id,
	});
	assert(member.size === 1, "upload prefix of a member sender allowed");

	console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
