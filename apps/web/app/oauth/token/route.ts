import { NextResponse } from "next/server";
import { tokenGrant } from "@/lib/mcp-oauth";
import { PUBLIC_HEADERS, oauthErrorResponse, preflight, readParams } from "@/lib/mcp-oauth-http";

// Echange d'un code (PKCE S256) ou d'un refresh token contre un jeton d'acces.
export async function POST(request: Request) {
	try {
		const params = await readParams(request);
		const tokens = await tokenGrant(params);
		return NextResponse.json(tokens, { headers: PUBLIC_HEADERS });
	} catch (err) {
		return oauthErrorResponse(err);
	}
}

export async function OPTIONS() {
	return preflight("POST, OPTIONS");
}
