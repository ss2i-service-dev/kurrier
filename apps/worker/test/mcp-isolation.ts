// Isolation of the mail MCP: a user can neither see nor touch another user's data
// (identity, folder, thread, message, attachment), through the access layer and through
// JSON-RPC. See mcp-test-env.ts for how to run it.
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
import { getDraftRow, upsertDraftRow } from "@common";
import type { ToolContext } from "../lib/mcp/tools";

async function main() {
	const a = await createUserFixture("alice");
	const b = await createUserFixture("bob");
	const ctxA: ToolContext = { userId: a.user.id, email: a.email, authType: "oauth", scopes: null };
	const ctxB: ToolContext = { userId: b.user.id, email: b.email, authType: "oauth", scopes: null };

	console.log("# access layer");
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

	console.log("# the owner does see their data");
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
	const batch = (await handleRpcBody(ctxB, Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })))) as any;
	assert(batch?.error?.code === -32600 && /Batch too large/.test(batch.error.message), "batch of 21 refused");
	const batchOk = (await handleRpcBody(ctxB, Array.from({ length: 20 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })))) as any;
	assert(Array.isArray(batchOk) && batchOk.length === 20, "batch of 20 accepted");

	console.log("# API key scopes");
	const keyReceive: ToolContext = { ...ctxB, authType: "api_key", scopes: ["emails:receive"] };
	const keySend: ToolContext = { ...ctxB, authType: "api_key", scopes: ["emails:send"] };
	const sendDenied = await call(keyReceive, "send_email", { to: ["x@test.invalid"], subject: "s", body_text: "b" });
	assert(sendDenied?.result?.isError === true && /lacks the 'emails:send'/.test(sendDenied.result.content[0].text), "emails:receive key cannot send_email");
	const readDenied = await call(keySend, "list_threads", {});
	assert(readDenied?.result?.isError === true && /lacks the 'emails:receive'/.test(readDenied.result.content[0].text), "emails:send key cannot list_threads");
	const readOk = await call(keyReceive, "list_threads", {});
	assert(readOk?.result?.isError !== true, "emails:receive key can list_threads");
	const replyDenied = await call(keyReceive, "reply", { message_id: b.message.id, body_text: "x" });
	assert(replyDenied?.result?.isError === true && /lacks/.test(replyDenied.result.content[0].text), "emails:receive key cannot reply");

	console.log("# header injection");
	const crlfSubject = await call(ctxB, "send_email", { to: ["x@test.invalid"], subject: "Hello\nBcc: evil@test.invalid", body_text: "b" });
	assert(crlfSubject?.result?.isError === true && /line breaks/.test(crlfSubject.result.content[0].text), "subject with LF refused");
	const crlfTo = await call(ctxB, "send_email", { to: ["x@test.invalid\r\nBcc: evil@test.invalid"], subject: "s", body_text: "b" });
	assert(crlfTo?.result?.isError === true && /line break in address|invalid address/.test(crlfTo.result.content[0].text), "recipient with CRLF refused");
	const crlfFolder = await call(ctxB, "list_threads", { folder: "inbox\n" });
	assert(crlfFolder?.result?.isError === true && /line breaks/.test(crlfFolder.result.content[0].text), "folder with LF refused");

	console.log("# drafts");
	const draftA = await upsertDraftRow({
		ownerId: a.user.id,
		identityId: a.identity.id,
		to: ["someone@test.invalid"],
		subject: "Draft of alice",
		text: "draft body alice",
		html: "<p>draft body alice</p>",
		mode: "reply",
		originalMessageId: a.message.id,
	});
	const dGetB = await call(ctxB, "get_draft", { draft_id: draftA.id });
	assert(dGetB?.result?.isError === true && /Draft not found/.test(dGetB.result.content[0].text), "get_draft(A's draft) as B -> isError");
	const dUpdB = await call(ctxB, "update_draft", { draft_id: draftA.id, subject: "hijacked" });
	assert(dUpdB?.result?.isError === true && /Draft not found/.test(dUpdB.result.content[0].text), "update_draft(A's draft) as B -> isError");
	const dDelB = await call(ctxB, "delete_draft", { draft_id: draftA.id });
	assert(dDelB?.result?.isError === true && /Draft not found/.test(dDelB.result.content[0].text), "delete_draft(A's draft) as B -> isError");
	const dSendB = await call(ctxB, "send_draft", { draft_id: draftA.id });
	assert(dSendB?.result?.isError === true && /Draft not found/.test(dSendB.result.content[0].text), "send_draft(A's draft) as B -> isError");
	const dListB = await call(ctxB, "list_drafts", { identity: a.email });
	assert(dListB?.result?.isError === true, "list_drafts(identity A) as B -> isError");
	const dListBOwn = await call(ctxB, "list_drafts", {});
	assert(dListBOwn?.result?.isError !== true && dListBOwn.result.structuredContent.drafts.length === 0, "list_drafts as B is empty");
	const replyDraftB = await call(ctxB, "reply", { message_id: a.message.id, body_text: "x", as_draft: true });
	assert(replyDraftB?.result?.isError === true && /Message not found/.test(replyDraftB.result.content[0].text), "reply as_draft on A's message as B -> isError");
	const still = await getDraftRow({ ownerId: a.user.id, draftMessageId: draftA.id });
	assert(still !== null && still.subject === "Draft of alice", "A's draft untouched after B's attempts");
	const dGetA = await call(ctxA, "get_draft", { draft_id: draftA.id });
	assert(
		dGetA?.result?.isError !== true &&
			dGetA.result.structuredContent.body_text === "draft body alice" &&
			dGetA.result.structuredContent.mode === "reply" &&
			dGetA.result.structuredContent.original_message_id === a.message.id &&
			dGetA.result.structuredContent.thread_id === a.thread.id,
		"get_draft as A: body, reply mode, original message, attached to the thread",
	);
	const dListA = await call(ctxA, "list_drafts", {});
	assert(dListA?.result?.structuredContent?.drafts?.some((d: any) => d.draft_id === draftA.id), "list_drafts as A lists the draft");
	const notDraft = await call(ctxA, "get_draft", { draft_id: a.message.id });
	assert(notDraft?.result?.isError === true && /Draft not found/.test(notDraft.result.content[0].text), "get_draft on a regular message -> Draft not found");
	const draftScope = await call(keyReceive, "reply", { message_id: a.message.id, body_text: "x", as_draft: true });
	assert(draftScope?.result?.isError === true && /Message not found/.test(draftScope.result.content[0].text), "reply as_draft needs only emails:receive (scope check passed)");
	const sendDraftScope = await call(keyReceive, "send_draft", { draft_id: draftA.id });
	assert(sendDraftScope?.result?.isError === true && /lacks the 'emails:send'/.test(sendDraftScope.result.content[0].text), "send_draft needs emails:send");

	console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
