import { NextResponse } from "next/server";
import { registerClient } from "@/lib/mcp-oauth";
import { PUBLIC_HEADERS, oauthErrorResponse, preflight, readJsonObject } from "@/lib/mcp-oauth-http";

// RFC 7591: dynamic registration of an MCP client (Claude Code, claude.ai).
// Public; only redirect URIs from the allowlist are accepted.
export async function POST(request: Request) {
	try {
		const body = await readJsonObject(request);
		const client = await registerClient(body);
		return NextResponse.json(client, { status: 201, headers: PUBLIC_HEADERS });
	} catch (err) {
		return oauthErrorResponse(err);
	}
}

export async function OPTIONS() {
	return preflight("POST, OPTIONS");
}
