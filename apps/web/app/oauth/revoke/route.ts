import { NextResponse } from "next/server";
import { revokeToken } from "@/lib/mcp-oauth";
import { PUBLIC_HEADERS, oauthErrorResponse, preflight, readParams } from "@/lib/mcp-oauth-http";

// RFC 7009: revocation of an access or refresh token. Always 200.
export async function POST(request: Request) {
	try {
		const params = await readParams(request);
		await revokeToken(String(params.token ?? ""));
		return new NextResponse(null, { status: 200, headers: PUBLIC_HEADERS });
	} catch (err) {
		return oauthErrorResponse(err);
	}
}

export async function OPTIONS() {
	return preflight("POST, OPTIONS");
}
