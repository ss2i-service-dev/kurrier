import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from "h3";
import { authenticateMcp, setUnauthorizedHeader } from "../../../../lib/mcp/auth";

// GET /api/kurrier/mcp: the server pushes nothing (no notifications), but a bare 405
// makes some clients fail at startup (Claude Code reports). Like the official SDK in
// stateless mode: if the client accepts text/event-stream, an empty SSE stream kept alive
// by keepalive comments; otherwise 405.
export default defineEventHandler(async (event) => {
	try {
		await authenticateMcp(event);
	} catch {
		setUnauthorizedHeader(event);
		setResponseStatus(event, 401);
		return { error: "invalid_token", message: "Unauthorized" };
	}
	const accept = String(getRequestHeader(event, "accept") ?? "");
	if (!accept.includes("text/event-stream")) {
		setResponseStatus(event, 405);
		setResponseHeader(event, "Allow", "POST");
		return { error: "method_not_allowed", message: "Use POST for JSON-RPC messages" };
	}

	const res = event.node.res;
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": connected\n\n");
	const timer = setInterval(() => {
		try {
			res.write(": keepalive\n\n");
		} catch {
			clearInterval(timer);
		}
	}, 25_000);
	await new Promise<void>((resolve) => {
		const done = () => {
			clearInterval(timer);
			resolve();
		};
		event.node.req.on("close", done);
		res.on("close", done);
	});
	event._handled = true;
	return undefined;
});
