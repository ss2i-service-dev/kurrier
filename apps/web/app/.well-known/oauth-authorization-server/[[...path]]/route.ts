import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp-oauth";

// RFC 8414: metadata of the built-in authorization server (the web app's OAuth endpoints).
const headers = {
	"Access-Control-Allow-Origin": "*",
	"Cache-Control": "public, max-age=3600",
};

export async function GET() {
	return NextResponse.json(authorizationServerMetadata(), { headers });
}

export async function OPTIONS() {
	return new NextResponse(null, {
		status: 204,
		headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" },
	});
}
