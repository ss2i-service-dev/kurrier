// Cloisonnement de l'MCP courrier : un utilisateur ne voit ni ne touche les donnees
// d'un autre (identite, dossier, fil, message, piece jointe), par la couche d'acces et
// par le JSON-RPC. Voir mcp-test-env.ts pour le lancement.
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import {
	getOwnedAttachment,
	getOwnedMailbox,
	getOwnedMessage,
	listMailboxes,
	listThreads,
	resolveActionTargets,
	resolveIdentity,
	resolveMailbox,
	threadMessages,
	threadPlacements,
} from "../lib/mcp/access";
import { handleRpcBody } from "../lib/mcp/rpc";
import type { ToolContext } from "../lib/mcp/tools";

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const ctxA: ToolContext = { userId: a.user.id, email: a.email, authType: "oauth" };
	const ctxB: ToolContext = { userId: b.user.id, email: b.email, authType: "oauth" };

	console.log("# couche d'acces");
	await expectThrow(() => resolveIdentity(b.user.id, a.identity.id), /Identity not found/, "identity of A by id, as B");
	await expectThrow(() => resolveIdentity(b.user.id, a.email), /Identity not found/, "identity of A by email, as B");
	await expectThrow(() => resolveMailbox(b.user.id, a.identity.id, "inbox"), /Folder not found/, "inbox of A, as B");
	await expectThrow(() => getOwnedMailbox(b.user.id, a.inbox.id), /Folder not found/, "mailbox of A by id, as B");
	assert((await listMailboxes(b.user.id, a.identity.id)).length === 0, "listMailboxes(B, identity A) is empty");
	assert(
		(await listThreads({ userId: b.user.id, mailboxId: a.inbox.id, limit: 10, offset: 0 })).length === 0,
		"listThreads(B, inbox A) is empty",
	);
	assert((await threadPlacements(b.user.id, [a.thread.id])).length === 0, "threadPlacements(B, thread A) is empty");
	await expectThrow(() => threadMessages(b.user.id, a.thread.id), /Thread not found/, "thread of A, as B");
	await expectThrow(() => getOwnedMessage(b.user.id, a.message.id), /Message not found/, "message of A, as B");
	await expectThrow(() => getOwnedAttachment(b.user.id, a.attachment.id), /Attachment not found/, "attachment of A, as B");
	await expectThrow(
		() => resolveActionTargets({ userId: b.user.id, threadIds: [a.thread.id] }),
		/Thread not found/,
		"action target thread A, as B",
	);
	await expectThrow(
		() => resolveActionTargets({ userId: b.user.id, threadIds: [b.thread.id, a.thread.id] }),
		/Thread not found: .*alice|Thread not found/,
		"mixed list (B's and A's threads), as B, is refused as a whole",
	);
	await expectThrow(() => threadMessages(b.user.id, "not-a-uuid"), /Invalid thread id/, "malformed id refused");

	console.log("# le proprietaire, lui, voit ses donnees");
	assert((await threadMessages(a.user.id, a.thread.id)).length === 1, "thread of A, as A");
	assert((await getOwnedAttachment(a.user.id, a.attachment.id)).id === a.attachment.id, "attachment of A, as A");
	const targets = await resolveActionTargets({ userId: a.user.id, threadIds: [a.thread.id] });
	assert(targets.length === 1 && targets[0].mailbox.id === a.inbox.id, "action target resolves to A's inbox");

	console.log("# JSON-RPC");
	const call = (ctx: ToolContext, name: string, args: Record<string, unknown>) =>
		handleRpcBody(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<any>;

	const init = (await handleRpcBody(ctxB, {
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
	})) as any;
	assert(init?.result?.protocolVersion === "2025-03-26", "initialize echoes a supported protocol version");
	assert(
		(await handleRpcBody(ctxB, { jsonrpc: "2.0", method: "notifications/initialized" })) === null,
		"notification gets no response",
	);
	const list = (await handleRpcBody(ctxB, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
	const names = (list?.result?.tools ?? []).map((t: any) => t.name);
	assert(names.includes("get_thread") && names.includes("trash") && !names.includes("delete_forever"), `tools/list: ${names.length} tools, no permanent delete`);

	const asB = await call(ctxB, "get_thread", { thread_id: a.thread.id });
	assert(asB?.result?.isError === true && /Thread not found/.test(asB.result.content[0].text), "get_thread(A's thread) as B -> isError");
	const asA = await call(ctxA, "get_thread", { thread_id: a.thread.id });
	assert(asA?.result?.isError !== true && /only alice may read/.test(asA.result.content[0].text), "get_thread(A's thread) as A -> body");
	assert(asA?.result?.structuredContent?.messages?.[0]?.seen === false, "get_thread does not mark read");

	const attB = await call(ctxB, "get_attachment", { attachment_id: a.attachment.id });
	assert(attB?.result?.isError === true, "get_attachment(A's) as B -> isError");
	const foldersB = await call(ctxB, "list_folders", { identity: a.email });
	assert(foldersB?.result?.isError === true, "list_folders(identity A) as B -> isError");
	const threadsB = await call(ctxB, "list_threads", {});
	assert(
		threadsB?.result?.isError !== true &&
			threadsB.result.structuredContent.items.every((t: any) => t.thread_id !== a.thread.id),
		"list_threads as B never lists A's thread",
	);
	const replyB = await call(ctxB, "reply", { message_id: a.message.id, body_text: "x" });
	assert(replyB?.result?.isError === true && /Message not found/.test(replyB.result.content[0].text), "reply to A's message as B -> isError");
	const fwdB = await call(ctxB, "forward", { message_id: a.message.id, to: ["x@test.invalid"], body_text: "x" });
	assert(fwdB?.result?.isError === true, "forward A's message as B -> isError");
	const trashB = await call(ctxB, "trash", { thread_ids: [a.thread.id] });
	assert(trashB?.result?.isError === true && /Thread not found/.test(trashB.result.content[0].text), "trash A's thread as B -> isError");
	const unknown = (await handleRpcBody(ctxB, { jsonrpc: "2.0", id: 3, method: "resources/read" })) as any;
	assert(unknown?.error?.code === -32601, "unknown method -> -32601");

	console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
