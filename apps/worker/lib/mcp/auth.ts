import { H3Event, setResponseHeader } from "h3";
import { db, mcpOauthAccessTokens, users } from "@db";
import { and, eq, gt } from "drizzle-orm";
import crypto from "node:crypto";
import { validateApiKeyToken } from "../api-helpers";

// Authentification de l'MCP courrier, sur le meme principe que l'MCP Organize-It :
// 1. Authorization: Bearer <jeton OAuth emis par /oauth/token du web> (stocke hache) ;
// 2. Authorization: Bearer <cle API kurrier> ou X-API-Key: <cle API> (repli).
// Jamais la cle en parametre de requete : elle finirait dans les journaux de Traefik.
// Un 401 porte WWW-Authenticate avec resource_metadata, ce qui declenche la decouverte
// OAuth chez Claude Code et claude.ai (RFC 9728).
// Portees : un jeton OAuth donne l'acces complet (mcp:full) ; une cle API garde ses
// api_keys.scopes (emails:send pour envoyer, emails:receive pour le reste), verifiees
// par outil dans rpc.ts.

export type McpPrincipal = {
	userId: string;
	email: string;
	authType: "oauth" | "api_key";
	// null = acces complet (OAuth) ; sinon les portees de la cle API.
	scopes: string[] | null;
};

export class McpAuthError extends Error {
	statusCode = 401;
}

export function sha256(value: string) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

// Origine publique de l'MCP et de sa decouverte OAuth : MCP_PUBLIC_ORIGIN
// (https://mail.ss2i.ca:8443 sur hlm, entrypoint Traefik sans custom-errors, qui
// sinon avalait le 401 et son WWW-Authenticate), a defaut WEB_URL, a defaut l'hote de
// la requete tel que Traefik le transmet. Meme valeur que apps/web/lib/mcp-oauth.ts.
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
	// Trace d'usage, sans jamais bloquer l'appel.
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
	// Les cles API kurrier ont la forme <prefixe>.<secret> ; un jeton OAuth n'a pas de
	// point. On evite ainsi une requete inutile dans chaque table.
	const looksLikeApiKey = extracted.token.includes(".");
	if (extracted.fromBearer && !looksLikeApiKey) {
		const principal = await resolveOauthToken(extracted.token);
		if (principal) return principal;
	}
	const principal = await resolveApiKey(extracted.token);
	if (principal) return principal;
	throw new McpAuthError("Invalid or expired token");
}
