import { defineEventHandler, readRawBody, setResponseHeader, setResponseStatus } from "h3";
import { McpAuthError, authenticateMcp, setUnauthorizedHeader } from "../../../../lib/mcp/auth";
import { PARSE_ERROR, handleRpcBody, rpcError } from "../../../../lib/mcp/rpc";

// MCP courrier, transport Streamable HTTP sans etat : POST /api/kurrier/mcp.
// Authentification : jeton OAuth (emis par le web, /oauth/*) ou cle API kurrier
// (lib/mcp/auth.ts). Reponses JSON ; l'en-tete Accept n'est pas exige (certains
// clients ne l'envoient pas). Tout le reste est dans lib/mcp/.
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

	let body: unknown;
	try {
		const raw = (await readRawBody(event, "utf8")) || "";
		body = JSON.parse(raw);
	} catch {
		setResponseStatus(event, 400);
		return rpcError(null, PARSE_ERROR, "Parse error: body must be JSON");
	}

	const response = await handleRpcBody(
		{ userId: principal.userId, email: principal.email, authType: principal.authType },
		body,
	);
	if (response === null) {
		// Notification(s) seule(s) : accepte sans corps.
		setResponseStatus(event, 202);
		return "";
	}
	setResponseHeader(event, "Content-Type", "application/json");
	return response;
});
