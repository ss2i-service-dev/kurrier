import crypto from "node:crypto";
import { and, eq, lt, notExists, or, sql } from "drizzle-orm";
import {
	db,
	mcpOauthAccessTokens,
	mcpOauthAuthorizationCodes,
	mcpOauthClients,
} from "@db";
import { getPublicEnv } from "@schema";

// Built-in OAuth 2.1 server for the Kurrier MCP endpoint: RFC 9728 + RFC 8414 discovery,
// RFC 7591 dynamic registration, code + PKCE S256, refresh token with rotation, RFC 7009
// revocation.
// The routes of apps/web/app/oauth/* and /.well-known/* only call this module, which makes
// it testable without a Next server (apps/worker/test/mcp-oauth-flow.ts).
// Codes and tokens are stored hashed (sha256); the plain value is only returned once.

export const MCP_SCOPE = "mcp:full";
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days (default)
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 3600;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
// An already rotated refresh token stays accepted for 60 s: a client that loses the response
// (network cut, two simultaneous refreshes) is not stuck on a dead token.
export const REFRESH_GRACE_SECONDS = 60;

export const MCP_PATH = "/api/kurrier/mcp";
const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];

// Purge: expired codes, tokens whose refresh is expired or that were revoked more than
// a day ago (beyond the grace window), clients older than 24 h with no token or code
// (registration with no follow-up). Called on every client registration.
export async function purgeOauthLeftovers(now = new Date()) {
	const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
	await db.delete(mcpOauthAuthorizationCodes).where(lt(mcpOauthAuthorizationCodes.expiresAt, now));
	await db
		.delete(mcpOauthAccessTokens)
		.where(
			or(
				lt(mcpOauthAccessTokens.refreshTokenExpiresAt, now),
				and(eq(mcpOauthAccessTokens.revoked, true), lt(mcpOauthAccessTokens.updatedAt, dayAgo)),
			),
		);
	await db
		.delete(mcpOauthClients)
		.where(
			and(
				lt(mcpOauthClients.createdAt, dayAgo),
				notExists(
					db.select({ one: sql`1` }).from(mcpOauthAccessTokens).where(eq(mcpOauthAccessTokens.clientId, mcpOauthClients.id)),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(mcpOauthAuthorizationCodes)
						.where(eq(mcpOauthAuthorizationCodes.clientId, mcpOauthClients.id)),
				),
			),
		);
}

export class OAuthError extends Error {
	constructor(
		public error: string,
		public description: string,
		public status = 400,
	) {
		super(description);
	}
}

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString("base64url");

// Public address of the webmail (login, session): WEB_URL.
export function baseUrl() {
	return String(getPublicEnv().WEB_URL ?? "").trim().replace(/\/+$/, "");
}

// Public address of everything serving the MCP (resource, discovery, /oauth/*):
// MCP_PUBLIC_ORIGIN. Useful when a reverse proxy in front of the default port rewrites
// error responses (replacing any 400-599 status with an HTML page and dropping headers:
// the 401 then arrived without WWW-Authenticate). Defaults to WEB_URL.
// Never request.url: inside the container it is the listen address (0.0.0.0:3000).
export function mcpPublicOrigin() {
	const configured = String(getPublicEnv().MCP_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
	return configured || baseUrl();
}

// Return to /oauth/authorize after login (oauth_return cookie): a relative path or an
// absolute URL on the MCP origin, nothing else (no open redirect).
export function isSafeOauthReturn(value: string) {
	if (value.startsWith("/oauth/authorize?")) return true;
	try {
		const url = new URL(value);
		const origin = new URL(mcpPublicOrigin()).origin;
		return url.origin === origin && url.pathname === "/oauth/authorize" && !url.username && !url.hash;
	} catch {
		return false;
	}
}

export function protectedResourceMetadata() {
	const base = mcpPublicOrigin();
	return {
		resource: `${base}${MCP_PATH}`,
		authorization_servers: [base],
		scopes_supported: [MCP_SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "Kurrier",
	};
}

export function authorizationServerMetadata() {
	const base = mcpPublicOrigin();
	return {
		issuer: base,
		authorization_endpoint: `${base}/oauth/authorize`,
		token_endpoint: `${base}/oauth/token`,
		registration_endpoint: `${base}/oauth/register`,
		revocation_endpoint: `${base}/oauth/revoke`,
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
		revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
		code_challenge_methods_supported: ["S256"],
		scopes_supported: [MCP_SCOPE],
	};
}

// ---------------------------------------------------------------------------
// redirect_uri: closed list. Native client on the loopback interface (Claude Code, any
// port) or the claude.ai callback (web connector and desktop application).
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REMOTE_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback"]);

export function isAcceptableRedirectUri(uri: string) {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.username || url.password || url.hash) return false;
	if (LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(url.host.split(":")[0])) {
		return url.protocol === "http:" || url.protocol === "https:";
	}
	return REMOTE_CALLBACKS.has(`${url.origin}${url.pathname}`) && url.protocol === "https:";
}

// The port of a loopback address is not significant (RFC 8252).
function loopbackKey(uri: string) {
	try {
		const url = new URL(uri);
		if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
		return `${url.protocol}//${url.hostname}${url.pathname}`;
	} catch {
		return null;
	}
}

export function isRedirectUriAllowed(uri: string, allowed: string[]) {
	if (!isAcceptableRedirectUri(uri)) return false;
	if (allowed.includes(uri)) return true;
	const key = loopbackKey(uri);
	return key !== null && allowed.some((a) => loopbackKey(a) === key);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export type OAuthClient = typeof mcpOauthClients.$inferSelect;

export async function registerClient(body: Record<string, unknown>) {
	const clientName = String(body.client_name ?? "").trim();
	if (!clientName || clientName.length > 255) {
		throw new OAuthError("invalid_client_metadata", "client_name is required");
	}
	const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
	if (!uris.length) {
		throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
	}
	for (const uri of uris) {
		if (!isAcceptableRedirectUri(uri)) {
			throw new OAuthError(
				"invalid_redirect_uri",
				`redirect_uri not allowed: ${uri} (loopback or https://claude.ai/api/mcp/auth_callback only)`,
			);
		}
	}
	const method = String(body.token_endpoint_auth_method ?? "none");
	if (!["none", "client_secret_post"].includes(method)) {
		throw new OAuthError("invalid_client_metadata", "unsupported token_endpoint_auth_method");
	}
	// grant_types and response_types: only what the server can do.
	const grantTypes = Array.isArray(body.grant_types)
		? body.grant_types.map(String)
		: ["authorization_code", "refresh_token"];
	const responseTypes = Array.isArray(body.response_types) ? body.response_types.map(String) : ["code"];
	const badGrant = grantTypes.filter((g) => !SUPPORTED_GRANT_TYPES.includes(g));
	if (badGrant.length || !grantTypes.includes("authorization_code")) {
		throw new OAuthError("invalid_client_metadata", `unsupported grant_types: ${badGrant.join(", ") || "authorization_code required"}`);
	}
	if (responseTypes.some((r) => r !== "code")) {
		throw new OAuthError("invalid_client_metadata", "only response_type code is supported");
	}
	// Housekeeping as we go (no scheduler to add): expired codes, dead tokens, clients
	// registered with no follow-up. Never blocking.
	purgeOauthLeftovers().catch((err) => console.error("[oauth] purge failed:", err?.message ?? err));
	const clientId = crypto.randomUUID();
	const clientSecret = method === "client_secret_post" ? randomToken(48) : null;
	await db.insert(mcpOauthClients).values({
		clientId,
		clientSecretHash: clientSecret ? sha256(clientSecret) : null,
		clientName,
		redirectUris: uris,
		tokenEndpointAuthMethod: method,
		grantTypes,
		responseTypes,
	});
	return {
		client_id: clientId,
		...(clientSecret ? { client_secret: clientSecret } : {}),
		client_id_issued_at: Math.floor(Date.now() / 1000),
		client_name: clientName,
		redirect_uris: uris,
		token_endpoint_auth_method: method,
		grant_types: grantTypes,
		response_types: responseTypes,
	};
}

export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
	if (!clientId) return null;
	const [client] = await db
		.select()
		.from(mcpOauthClients)
		.where(eq(mcpOauthClients.clientId, clientId))
		.limit(1);
	return client ?? null;
}

function clientSecretMatches(client: OAuthClient, secret: string | null | undefined) {
	if (client.tokenEndpointAuthMethod !== "client_secret_post") return true;
	if (!secret || !client.clientSecretHash) return false;
	const a = Buffer.from(client.clientSecretHash);
	const b = Buffer.from(sha256(secret));
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export type AuthorizeParams = {
	response_type?: string;
	client_id?: string;
	redirect_uri?: string;
	code_challenge?: string;
	code_challenge_method?: string;
	state?: string;
	scope?: string;
	resource?: string;
};

export const AUTHORIZE_PARAM_KEYS: (keyof AuthorizeParams)[] = [
	"response_type",
	"client_id",
	"redirect_uri",
	"code_challenge",
	"code_challenge_method",
	"state",
	"scope",
	"resource",
];

// Checks client and redirect_uri BEFORE any redirect: an unknown client or an unregistered
// address receives nothing (otherwise the endpoint acts as an open redirect).
export async function validateAuthorizeRequest(params: AuthorizeParams) {
	if (params.response_type !== "code") {
		throw new OAuthError("unsupported_response_type", "response_type must be code");
	}
	const client = await resolveClient(String(params.client_id ?? ""));
	if (!client) throw new OAuthError("invalid_client", "Unknown client");
	const redirectUri = String(params.redirect_uri ?? "");
	if (!isRedirectUriAllowed(redirectUri, client.redirectUris ?? [])) {
		throw new OAuthError("invalid_request", "redirect_uri not registered for this client");
	}
	if (!params.code_challenge || params.code_challenge_method !== "S256") {
		throw new OAuthError("invalid_request", "PKCE (code_challenge, S256) is required");
	}
	// Only one scope exists; any other value is rejected rather than ignored.
	const requested = String(params.scope ?? "").split(/\s+/).filter(Boolean);
	if (requested.some((s) => s !== MCP_SCOPE)) {
		throw new OAuthError("invalid_scope", `unknown scope (only ${MCP_SCOPE})`);
	}
	if (params.resource) {
		let ok = false;
		try {
			ok = new URL(params.resource).origin === new URL(mcpPublicOrigin()).origin;
		} catch {
			ok = false;
		}
		if (!ok) throw new OAuthError("invalid_target", "resource must be this server");
	}
	return { client, redirectUri };
}

export async function issueAuthorizationCode(opts: {
	client: OAuthClient;
	userId: string;
	redirectUri: string;
	codeChallenge: string;
	scope?: string;
	resource?: string;
}) {
	const code = randomToken(48);
	await db.insert(mcpOauthAuthorizationCodes).values({
		codeHash: sha256(code),
		clientId: opts.client.id,
		userId: opts.userId,
		redirectUri: opts.redirectUri,
		codeChallenge: opts.codeChallenge,
		codeChallengeMethod: "S256",
		scope: opts.scope || MCP_SCOPE,
		resource: opts.resource || null,
		expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
	});
	return code;
}

export function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>) {
	const url = new URL(redirectUri);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
	}
	return url.toString();
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function issueTokenPair(client: OAuthClient, userId: string, scope: string | null) {
	const accessToken = randomToken(48);
	const refreshToken = randomToken(48);
	const now = Date.now();
	await db.insert(mcpOauthAccessTokens).values({
		tokenHash: sha256(accessToken),
		refreshTokenHash: sha256(refreshToken),
		clientId: client.id,
		userId,
		scope: scope || MCP_SCOPE,
		expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
		refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
	});
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: "Bearer",
		expires_in: ACCESS_TOKEN_TTL_SECONDS,
		scope: scope || MCP_SCOPE,
	};
}

export async function exchangeAuthorizationCode(params: Record<string, string | undefined>) {
	const code = String(params.code ?? "");
	const codeVerifier = String(params.code_verifier ?? "");
	if (!code || !codeVerifier) {
		throw new OAuthError("invalid_request", "code and code_verifier are required");
	}
	// Single use and atomic: the deletion returns the row to the one who consumed it; of two
	// simultaneous exchanges of the same code, only one succeeds.
	const [row] = await db
		.delete(mcpOauthAuthorizationCodes)
		.where(eq(mcpOauthAuthorizationCodes.codeHash, sha256(code)))
		.returning();
	if (!row) throw new OAuthError("invalid_grant", "Invalid authorization code");
	if (row.expiresAt.getTime() < Date.now()) {
		throw new OAuthError("invalid_grant", "Authorization code expired");
	}
	const client = await resolveClient(String(params.client_id ?? ""));
	if (!client || client.id !== row.clientId) {
		throw new OAuthError("invalid_client", "Client mismatch", 401);
	}
	if (!clientSecretMatches(client, params.client_secret)) {
		throw new OAuthError("invalid_client", "Invalid client secret", 401);
	}
	// redirect_uri was always present at authorization: so it is mandatory here and must
	// be identical (RFC 6749 4.1.3).
	if (!params.redirect_uri) throw new OAuthError("invalid_request", "redirect_uri is required");
	if (params.redirect_uri !== row.redirectUri) {
		throw new OAuthError("invalid_grant", "redirect_uri mismatch");
	}
	const expected = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
	const a = Buffer.from(row.codeChallenge);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
		throw new OAuthError("invalid_grant", "Invalid code_verifier (PKCE)");
	}
	return issueTokenPair(client, row.userId, row.scope);
}

export async function refreshAccessToken(params: Record<string, string | undefined>) {
	const refreshToken = String(params.refresh_token ?? "");
	if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
	const [existing] = await db
		.select()
		.from(mcpOauthAccessTokens)
		.where(eq(mcpOauthAccessTokens.refreshTokenHash, sha256(refreshToken)))
		.limit(1);
	if (!existing) throw new OAuthError("invalid_grant", "Invalid refresh token");
	if (existing.refreshTokenExpiresAt.getTime() < Date.now()) {
		throw new OAuthError("invalid_grant", "Refresh token expired");
	}
	const withinGrace =
		existing.revoked &&
		existing.revokedAt !== null &&
		existing.revokedAt.getTime() > Date.now() - REFRESH_GRACE_SECONDS * 1000;
	if (existing.revoked && !withinGrace) {
		// An already rotated refresh presented after the grace period is a sign of theft
		// (RFC 6819 5.2.2.3): the whole client + user family is revoked, the thief as well as
		// the legitimate client, which only has to sign in again.
		await db
			.update(mcpOauthAccessTokens)
			.set({ revoked: true, updatedAt: new Date() })
			.where(
				and(
					eq(mcpOauthAccessTokens.clientId, existing.clientId),
					eq(mcpOauthAccessTokens.userId, existing.userId),
					eq(mcpOauthAccessTokens.revoked, false),
				),
			);
		throw new OAuthError("invalid_grant", "Refresh token revoked (token family revoked)");
	}
	const client = await resolveClient(String(params.client_id ?? ""));
	if (!client || client.id !== existing.clientId) {
		throw new OAuthError("invalid_client", "Client mismatch", 401);
	}
	if (!clientSecretMatches(client, params.client_secret)) {
		throw new OAuthError("invalid_client", "Invalid client secret", 401);
	}
	// Rotation: the old token is revoked (once; within the grace window revokedAt is not
	// pushed back, otherwise every replay would extend it).
	if (!existing.revoked) {
		await db
			.update(mcpOauthAccessTokens)
			.set({ revoked: true, revokedAt: new Date(), updatedAt: new Date() })
			.where(eq(mcpOauthAccessTokens.id, existing.id));
	}
	return issueTokenPair(client, existing.userId, existing.scope);
}

// RFC 7009: always 200, even for an unknown token. No revokedAt: an explicit revocation is
// final, without a grace window.
export async function revokeToken(token: string) {
	if (!token) return;
	const hash = sha256(token);
	await db
		.update(mcpOauthAccessTokens)
		.set({ revoked: true, updatedAt: new Date() })
		.where(
			or(eq(mcpOauthAccessTokens.tokenHash, hash), eq(mcpOauthAccessTokens.refreshTokenHash, hash)),
		);
}

export async function tokenGrant(params: Record<string, string | undefined>) {
	switch (params.grant_type) {
		case "authorization_code":
			return exchangeAuthorizationCode(params);
		case "refresh_token":
			return refreshAccessToken(params);
		default:
			throw new OAuthError(
				"unsupported_grant_type",
				"Only authorization_code and refresh_token are supported",
			);
	}
}

// Active tokens of a user (for a future "connected access" page).
export async function listActiveTokens(userId: string) {
	return db
		.select({
			id: mcpOauthAccessTokens.id,
			clientName: mcpOauthClients.clientName,
			createdAt: mcpOauthAccessTokens.createdAt,
			expiresAt: mcpOauthAccessTokens.expiresAt,
			lastUsedAt: mcpOauthAccessTokens.lastUsedAt,
		})
		.from(mcpOauthAccessTokens)
		.innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthAccessTokens.clientId))
		.where(and(eq(mcpOauthAccessTokens.userId, userId), eq(mcpOauthAccessTokens.revoked, false)));
}

// ---------------------------------------------------------------------------
// Consent page (HTML served by the route, without React: outside the [locale] tree and
// with no dependency on the dashboard layout).
// ---------------------------------------------------------------------------

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function consentPage(opts: {
	clientName: string;
	userEmail: string;
	params: AuthorizeParams;
	csrf: string;
}) {
	const hidden = AUTHORIZE_PARAM_KEYS.filter((k) => opts.params[k] !== undefined)
		.map((k) => `<input type="hidden" name="${k}" value="${esc(String(opts.params[k]))}">`)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access - Kurrier</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f5;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#18181b}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;max-width:440px;width:calc(100% - 32px);box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 8px}
p{margin:8px 0;line-height:1.5}
.muted{color:#71717a;font-size:14px}
ul{margin:12px 0;padding-left:20px;line-height:1.6}
.actions{display:flex;gap:12px;margin-top:24px}
button{flex:1;padding:10px 16px;border-radius:8px;border:1px solid #d4d4d8;background:#fff;font-size:15px;cursor:pointer}
button.primary{background:#18181b;color:#fff;border-color:#18181b}
code{background:#f4f4f5;padding:1px 5px;border-radius:4px;font-size:13px}
</style>
</head>
<body>
<form class="card" method="post" action="/oauth/authorize">
<h1>Authorize <strong>${esc(opts.clientName)}</strong>?</h1>
<p class="muted">Signed in as <code>${esc(opts.userEmail)}</code></p>
<p>This application will be able to, on your behalf:</p>
<ul>
<li>read your folders, threads and messages, and search your mail</li>
<li>send, reply to and forward messages with your identities</li>
<li>mark read or unread, star, file, archive and move to the trash</li>
</ul>
<p class="muted">Nothing is ever permanently deleted. Access lasts 30 days and is renewed as long as you do not revoke it.</p>
${hidden}
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<div class="actions">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="approve" class="primary">Authorize</button>
</div>
</form>
</body>
</html>`;
}
