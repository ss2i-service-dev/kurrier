import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp-oauth";

// RFC 8414 : metadonnees du serveur d'autorisation integre (endpoints OAuth du web).
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
