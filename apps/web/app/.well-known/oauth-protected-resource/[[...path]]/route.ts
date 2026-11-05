import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp-oauth";

// RFC 9728: metadata of the protected resource (the MCP endpoint), at the root and
// under the resource path (/.well-known/oauth-protected-resource/api/kurrier/mcp).
const headers = {
	"Access-Control-Allow-Origin": "*",
	"Cache-Control": "public, max-age=3600",
};

export async function GET() {
	return NextResponse.json(protectedResourceMetadata(), { headers });
}

export async function OPTIONS() {
	return new NextResponse(null, {
		status: 204,
		headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" },
	});
}
