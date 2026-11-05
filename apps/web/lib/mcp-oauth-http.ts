import { NextResponse } from "next/server";
import { OAuthError } from "@/lib/mcp-oauth";

// Small HTTP helpers shared by the /oauth/* routes: JSON or form body, error responses in
// OAuth format, open CORS on the public endpoints (an MCP client in a browser, like the MCP
// inspector, calls them directly).

export const PUBLIC_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Cache-Control": "no-store",
	Pragma: "no-cache",
};

export async function readParams(request: Request): Promise<Record<string, string | undefined>> {
	const type = request.headers.get("content-type") ?? "";
	const out: Record<string, string | undefined> = {};
	if (type.includes("application/json")) {
		const json = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		for (const [k, v] of Object.entries(json)) {
			if (v === undefined || v === null) continue;
			out[k] = typeof v === "string" ? v : JSON.stringify(v);
		}
		return out;
	}
	const text = await request.text().catch(() => "");
	for (const [k, v] of new URLSearchParams(text)) out[k] = v;
	return out;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
	const json = await request.json().catch(() => null);
	return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

export function oauthErrorResponse(err: unknown) {
	if (err instanceof OAuthError) {
		return NextResponse.json(
			{ error: err.error, error_description: err.description },
			{ status: err.status, headers: PUBLIC_HEADERS },
		);
	}
	console.error("[oauth] unexpected error:", err);
	return NextResponse.json(
		{ error: "server_error", error_description: "Unexpected error" },
		{ status: 500, headers: PUBLIC_HEADERS },
	);
}

export function preflight(methods: string) {
	return new NextResponse(null, {
		status: 204,
		headers: {
			...PUBLIC_HEADERS,
			"Access-Control-Allow-Methods": methods,
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		},
	});
}
