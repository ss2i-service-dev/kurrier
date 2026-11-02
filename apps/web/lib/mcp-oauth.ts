import crypto from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import {
	db,
	mcpOauthAccessTokens,
	mcpOauthAuthorizationCodes,
	mcpOauthClients,
} from "@db";
import { getPublicEnv } from "@schema";

// Serveur OAuth 2.1 integre pour l'MCP courrier, sur le modele de celui d'Organize-It
// (McpOAuthController) : decouverte RFC 9728 + RFC 8414, enregistrement dynamique
// RFC 7591, code + PKCE S256, refresh token avec rotation, revocation RFC 7009.
// Les routes de apps/web/app/oauth/* et /.well-known/* ne font qu'appeler ce module,
// ce qui permet de le tester sans serveur Next (apps/worker/test/mcp-oauth-flow.ts).
// Codes et jetons sont stockes haches (sha256) ; le clair n'est rendu qu'une fois.

export const MCP_SCOPE = "mcp:full";
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 jours, regle des MCP internes SS2i
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 3600;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
// Un refresh token deja tourne reste accepte 60 s : un client qui perd la reponse
// (coupure, deux rafraichissements simultanes) ne reste pas bloque sur un jeton mort.
export const REFRESH_GRACE_SECONDS = 60;

export const MCP_PATH = "/api/kurrier/mcp";

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

export function baseUrl() {
	return String(getPublicEnv().WEB_URL ?? "").trim().replace(/\/+$/, "");
}

export function protectedResourceMetadata() {
	const base = baseUrl();
	return {
		resource: `${base}${MCP_PATH}`,
		authorization_servers: [base],
		scopes_supported: [MCP_SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "Courrier SS2i Services",
	};
}

export function authorizationServerMetadata() {
	const base = baseUrl();
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
// redirect_uri : liste fermee. Client natif en boucle locale (Claude Code, port
// quelconque) ou le rappel de claude.ai (connecteur web et application de bureau).
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

// Le port d'une adresse de boucle locale n'est pas significatif (RFC 8252).
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
	const grantTypes = Array.isArray(body.grant_types)
		? body.grant_types.map(String)
		: ["authorization_code", "refresh_token"];
	const responseTypes = Array.isArray(body.response_types) ? body.response_types.map(String) : ["code"];
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
// Autorisation
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

// Verifie client et redirect_uri AVANT toute redirection : un client inconnu ou une
// adresse non enregistree ne recoivent rien (sinon l'endpoint sert d'open redirect).
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
	if (params.resource) {
		let ok = false;
		try {
			ok = new URL(params.resource).origin === new URL(baseUrl()).origin;
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
// Jetons
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
	const [row] = await db
		.select()
		.from(mcpOauthAuthorizationCodes)
		.where(eq(mcpOauthAuthorizationCodes.codeHash, sha256(code)))
		.limit(1);
	if (!row) throw new OAuthError("invalid_grant", "Invalid authorization code");
	// Usage unique : le code disparait quel que soit le resultat de la suite.
	await db.delete(mcpOauthAuthorizationCodes).where(eq(mcpOauthAuthorizationCodes.id, row.id));
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
	if (params.redirect_uri && params.redirect_uri !== row.redirectUri) {
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
		throw new OAuthError("invalid_grant", "Refresh token revoked");
	}
	const client = await resolveClient(String(params.client_id ?? ""));
	if (!client || client.id !== existing.clientId) {
		throw new OAuthError("invalid_client", "Client mismatch", 401);
	}
	if (!clientSecretMatches(client, params.client_secret)) {
		throw new OAuthError("invalid_client", "Invalid client secret", 401);
	}
	// Rotation : l'ancien jeton est revoque (une fois ; dans la fenetre de grace on ne
	// repousse pas revokedAt, sinon chaque rejeu la prolongerait).
	if (!existing.revoked) {
		await db
			.update(mcpOauthAccessTokens)
			.set({ revoked: true, revokedAt: new Date(), updatedAt: new Date() })
			.where(eq(mcpOauthAccessTokens.id, existing.id));
	}
	return issueTokenPair(client, existing.userId, existing.scope);
}

// RFC 7009 : toujours 200, meme pour un jeton inconnu. Pas de revokedAt : une
// revocation explicite est definitive, sans fenetre de grace.
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

// Jetons actifs d'un utilisateur (pour une future page « acces connectes »).
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
// Page de consentement (HTML servi par la route, sans React : hors de l'arbre
// [locale] et sans dependance a la mise en page du tableau de bord).
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
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser l'acces - Courrier</title>
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
<h1>Autoriser <strong>${esc(opts.clientName)}</strong> ?</h1>
<p class="muted">Connecte en tant que <code>${esc(opts.userEmail)}</code></p>
<p>Cette application pourra, en votre nom :</p>
<ul>
<li>lire vos dossiers, fils et messages, et rechercher dans votre courrier</li>
<li>envoyer, repondre et transferer des messages avec vos identites</li>
<li>marquer lu ou non lu, mettre en favori, ranger, archiver et mettre a la corbeille</li>
</ul>
<p class="muted">Rien n'est jamais supprime definitivement. L'acces vaut 30 jours et se renouvelle tant que vous ne le revoquez pas.</p>
${hidden}
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<div class="actions">
<button type="submit" name="decision" value="deny">Refuser</button>
<button type="submit" name="decision" value="approve" class="primary">Autoriser</button>
</div>
</form>
</body>
</html>`;
}
