import { H3Event, setResponseHeader } from "h3";
import { db, mcpOauthAccessTokens, users } from "@db";
import { and, eq, gt } from "drizzle-orm";
import crypto from "node:crypto";
import { validateApiKeyToken } from "../api-helpers";

// Authentication of the mail MCP:
// 1. Authorization: Bearer <OAuth token issued by the web app's /oauth/token> (stored hashed);
// 2. Authorization: Bearer <kurrier API key> or X-API-Key: <API key> (fallback).
// Never the key as a query parameter: it would end up in reverse proxy logs.
// A 401 carries WWW-Authenticate with resource_metadata, which triggers OAuth discovery in
// Claude Code and claude.ai (RFC 9728).
// Scopes: an OAuth token gives full access (mcp:full); an API key keeps its api_keys.scopes
// (emails:send to send, emails:receive for the rest), checked per tool in rpc.ts.

export type McpPrincipal = {
	userId: string;
	email: string;
	authType: "oauth" | "api_key";
	// null = full access (OAuth); otherwise the API key's scopes.
	scopes: string[] | null;
};

export class McpAuthError extends Error {
	statusCode = 401;
}

export function sha256(value: string) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

// Public origin of the MCP and its OAuth discovery: MCP_PUBLIC_ORIGIN (for example when
// the MCP is exposed through a reverse proxy on a non-standard port, whose entrypoint must
// not swallow the 401 and its WWW-Authenticate header), otherwise WEB_URL, otherwise the
// request host as the reverse proxy forwards it. Same value as apps/web/lib/mcp-oauth.ts.
export function publicBaseUrl(event: H3Event) {
	const fromEnv = String(process.env.MCP_PUBLIC_ORIGIN || process.env.WEB_URL || "")
		.trim()
		.replace(/\/+$/, "");
	if (fromEnv) return fromEnv;
	const h = event.node.req.headers;
	const proto = String(h["x-forwarded-proto"] ?? "https").split(",")[0].trim();
	const host = String(h["x-forwarded-host"] ?? h.host ?? "").split(",")[0].trim();
	return `${proto}://${host}`;
}

export function setUnauthorizedHeader(event: H3Event) {
	setResponseHeader(
		event,
		"WWW-Authenticate",
		`Bearer resource_metadata="${publicBaseUrl(event)}/.well-known/oauth-protected-resource"`,
	);
}

function extractToken(event: H3Event): { token: string; fromBearer: boolean } | null {
	const auth = event.node.req.headers.authorization;
	if (auth && /^Bearer\s+/i.test(auth)) {
		const token = auth.replace(/^Bearer\s+/i, "").trim();
		if (token) return { token, fromBearer: true };
	}
	const xApiKey = event.node.req.headers["x-api-key"];
	if (typeof xApiKey === "string" && xApiKey.trim()) {
		return { token: xApiKey.trim(), fromBearer: false };
	}
	return null;
}

async function resolveOauthToken(token: string): Promise<McpPrincipal | null> {
	const now = new Date();
	const [row] = await db
		.select({
			id: mcpOauthAccessTokens.id,
			userId: mcpOauthAccessTokens.userId,
			email: users.email,
		})
		.from(mcpOauthAccessTokens)
		.innerJoin(users, eq(users.id, mcpOauthAccessTokens.userId))
		.where(
			and(
				eq(mcpOauthAccessTokens.tokenHash, sha256(token)),
				eq(mcpOauthAccessTokens.revoked, false),
				gt(mcpOauthAccessTokens.expiresAt, now),
			),
		)
		.limit(1);
	if (!row) return null;
	// Usage trace, never blocking the call.
	db.update(mcpOauthAccessTokens)
		.set({ lastUsedAt: now })
		.where(eq(mcpOauthAccessTokens.id, row.id))
		.catch(() => {});
	return { userId: row.userId, email: row.email, authType: "oauth", scopes: null };
}

async function resolveApiKey(token: string): Promise<McpPrincipal | null> {
	try {
		const { ownerId, apiKey } = await validateApiKeyToken(token);
		if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) return null;
		const [user] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, ownerId))
			.limit(1);
		if (!user) return null;
		return {
			userId: ownerId,
			email: user.email,
			authType: "api_key",
			scopes: Array.isArray(apiKey.scopes) ? apiKey.scopes.map(String) : [],
		};
	} catch {
		return null;
	}
}

export async function authenticateMcp(event: H3Event): Promise<McpPrincipal> {
	const extracted = extractToken(event);
	if (!extracted) {
		throw new McpAuthError("Provide an OAuth Bearer token or a kurrier API key");
	}
	// kurrier API keys have the form <prefix>.<secret>; an OAuth token has no dot. This
	// avoids a useless query in each table.
	const looksLikeApiKey = extracted.token.includes(".");
	if (extracted.fromBearer && !looksLikeApiKey) {
		const principal = await resolveOauthToken(extracted.token);
		if (principal) return principal;
	}
	const principal = await resolveApiKey(extracted.token);
	if (principal) return principal;
	throw new McpAuthError("Invalid or expired token");
}
