import { defineEventHandler, readRawBody, setResponseHeader, setResponseStatus } from "h3";
import { McpAuthError, authenticateMcp, setUnauthorizedHeader } from "../../../../lib/mcp/auth";
import { INVALID_REQUEST, PARSE_ERROR, handleRpcBody, rpcError } from "../../../../lib/mcp/rpc";

const MAX_BODY_BYTES = 40 * 1024 * 1024;

// Mail MCP, stateless Streamable HTTP transport: POST /api/kurrier/mcp.
// Authentication: OAuth token (issued by the web app, /oauth/*) or kurrier API key
// (lib/mcp/auth.ts). JSON responses; the Accept header is not required (some clients do
// not send it). Everything else is in lib/mcp/.
export default defineEventHandler(async (event) => {
	setResponseHeader(event, "Cache-Control", "no-store");
	let principal;
	try {
		principal = await authenticateMcp(event);
	} catch (err: any) {
		setUnauthorizedHeader(event);
		setResponseStatus(event, 401);
		return {
			error: "invalid_token",
			message: err instanceof McpAuthError ? err.message : "Unauthorized",
		};
	}

	// Bounded body (base64 attachments included): 413 beyond.
	const declared = Number(event.node.req.headers["content-length"] ?? 0);
	if (declared > MAX_BODY_BYTES) {
		setResponseStatus(event, 413);
		return rpcError(null, INVALID_REQUEST, `Body too large (max ${MAX_BODY_BYTES} bytes)`);
	}
	let body: unknown;
	try {
		const raw = (await readRawBody(event, "utf8")) || "";
		if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
			setResponseStatus(event, 413);
			return rpcError(null, INVALID_REQUEST, `Body too large (max ${MAX_BODY_BYTES} bytes)`);
		}
		body = JSON.parse(raw);
	} catch {
		setResponseStatus(event, 400);
		return rpcError(null, PARSE_ERROR, "Parse error: body must be JSON");
	}

	const response = await handleRpcBody(
		{ userId: principal.userId, email: principal.email, authType: principal.authType, scopes: principal.scopes },
		body,
	);
	if (response === null) {
		// Notification(s) only: accepted with no body.
		setResponseStatus(event, 202);
		return "";
	}
	setResponseHeader(event, "Content-Type", "application/json");
	return response;
});
