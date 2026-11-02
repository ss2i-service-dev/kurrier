import { NextResponse } from "next/server";
import { registerClient } from "@/lib/mcp-oauth";
import { PUBLIC_HEADERS, oauthErrorResponse, preflight, readJsonObject } from "@/lib/mcp-oauth-http";

// RFC 7591 : enregistrement dynamique d'un client MCP (Claude Code, claude.ai).
// Public, comme sur Organize-It ; seules les redirections de la liste fermee passent.
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
