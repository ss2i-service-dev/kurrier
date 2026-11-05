import { McpToolError } from "./access";
import { TOOLS, type ToolContext, findTool } from "./tools";

// JSON-RPC 2.0 of the mail MCP, stateless Streamable HTTP transport (one POST request =
// one JSON response). Hand-written: the only new dependency would have been
// @modelcontextprotocol/sdk, and the worker image installs from the pinned pnpm-lock.yaml,
// which a patch should not move.
// Accepted protocols: 2025-06-18 and 2025-03-26 (same shape for what we serve).

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";
export const SERVER_INFO = { name: "kurrier", title: "Kurrier", version: "1.0.0" };

const INSTRUCTIONS = [
	"Mailbox of the authenticated kurrier user. Start with whoami or list_identities,",
	"then list_folders / list_threads / search to find threads and get_thread to read them.",
	"Reading never marks a thread read unless asked. send_email, reply and forward send",
	"immediately through the regular pipeline: confirm with the user first. Nothing is",
	"ever deleted permanently (trash only moves to Trash).",
].join(" ");

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, any>;
};

export type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

export function toolList() {
	return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function callTool(ctx: ToolContext, params: Record<string, any> | undefined) {
	const name = String(params?.name ?? "");
	const tool = findTool(name);
	if (!tool) {
		return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
	}
	// API key: the tool's scope must be in api_keys.scopes. OAuth: everything.
	const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
	const scope = typeof tool.scope === "function" ? tool.scope(args) : tool.scope;
	if (ctx.scopes !== null && !ctx.scopes.includes(scope)) {
		return {
			content: [{ type: "text", text: `This API key lacks the '${scope}' scope required by ${name}` }],
			isError: true,
		};
	}
	try {
		const result = await tool.handler(ctx, args);
		const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
		return {
			content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
			structuredContent: structured,
		};
	} catch (err: any) {
		// Readable tool error (isError), not a JSON-RPC error: the model can fix its arguments.
		// An unexpected error stays generic for the client; the detail goes to the worker log
		// (without the arguments: no token, no mail).
		if (err instanceof McpToolError) {
			return { content: [{ type: "text", text: err.message }], isError: true };
		}
		console.error(`[mcp] tool ${name} failed for user ${ctx.userId}:`, err?.stack ?? err);
		return {
			content: [{ type: "text", text: `Tool ${name} failed (internal error, see worker logs)` }],
			isError: true,
		};
	}
}

// One request (or notification) -> one response, or null for a notification.
export async function handleRpcMessage(
	ctx: ToolContext,
	msg: unknown,
): Promise<JsonRpcResponse | null> {
	if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
		return rpcError(null, INVALID_REQUEST, "Invalid request");
	}
	const req = msg as JsonRpcRequest;
	const id: JsonRpcId = req.id === undefined ? null : req.id;
	const isNotification = req.id === undefined;
	if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
		return isNotification ? null : rpcError(id, INVALID_REQUEST, "Invalid request");
	}
	if (req.method.startsWith("notifications/")) return null;
	if (isNotification) return null;

	switch (req.method) {
		case "initialize": {
			const requested = String(req.params?.protocolVersion ?? "");
			return rpcResult(id, {
				protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
				instructions: INSTRUCTIONS,
			});
		}
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, { tools: toolList() });
		case "tools/call":
			return rpcResult(id, await callTool(ctx, req.params));
		case "resources/list":
			return rpcResult(id, { resources: [] });
		case "prompts/list":
			return rpcResult(id, { prompts: [] });
		default:
			return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
	}
}

export const MAX_BATCH = 20;

// Full body (object or batch) -> response to return (object, batch) or null (empty 202).
export async function handleRpcBody(ctx: ToolContext, body: unknown) {
	if (Array.isArray(body)) {
		if (!body.length) return rpcError(null, INVALID_REQUEST, "Empty batch");
		if (body.length > MAX_BATCH) {
			return rpcError(null, INVALID_REQUEST, `Batch too large (max ${MAX_BATCH})`);
		}
		const responses = (await Promise.all(body.map((m) => handleRpcMessage(ctx, m)))).filter(
			(r): r is JsonRpcResponse => r !== null,
		);
		return responses.length ? responses : null;
	}
	return handleRpcMessage(ctx, body);
}
