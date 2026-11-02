import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from "h3";
import { authenticateMcp, setUnauthorizedHeader } from "../../../../lib/mcp/auth";

// GET /api/kurrier/mcp : le serveur ne pousse rien (pas de notifications), mais un
// 405 sec fait echouer certains clients au demarrage (retours Claude Code). On fait
// comme le SDK officiel en mode sans etat : si le client accepte text/event-stream,
// un flux SSE vide maintenu par des commentaires keepalive ; sinon 405.
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
