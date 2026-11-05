// Full OAuth flow of the mail MCP, without a Next or Nitro server: dynamic registration
// -> authorization (user in session) -> PKCE code -> tokens -> worker authentication ->
// tools/list, then refresh with rotation and revocation. The OAuth core
// (apps/web/lib/mcp-oauth.ts) and the worker authentication (lib/mcp/auth.ts) are called
// directly. See mcp-test-env.ts for how to run it.
import crypto from "node:crypto";
import { assert, expectThrow, fakeEvent } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import {
	authorizationServerMetadata,
	exchangeAuthorizationCode,
	isRedirectUriAllowed,
	isSafeOauthReturn,
	issueAuthorizationCode,
	protectedResourceMetadata,
	refreshAccessToken,
	registerClient,
	revokeToken,
	sha256,
	validateAuthorizeRequest,
} from "../../web/lib/mcp-oauth";
import { authenticateMcp, setUnauthorizedHeader } from "../lib/mcp/auth";
import { db, mcpOauthAccessTokens } from "@db";
import { eq } from "drizzle-orm";
import { handleRpcBody } from "../lib/mcp/rpc";

async function main() {
	const a = await createUserFixture("carol");

	console.log("# discovery");
	const prm = protectedResourceMetadata();
	const asm = authorizationServerMetadata();
	assert(prm.resource.endsWith("/api/kurrier/mcp") && prm.authorization_servers[0] === asm.issuer, "resource metadata points to the issuer");
	assert(asm.code_challenge_methods_supported.includes("S256") && asm.registration_endpoint.endsWith("/oauth/register"), "server metadata: S256 + registration");
	assert(asm.issuer === process.env.MCP_PUBLIC_ORIGIN && prm.resource.startsWith(`${process.env.MCP_PUBLIC_ORIGIN}/`), `issuer and resource on MCP_PUBLIC_ORIGIN (${asm.issuer})`);
	assert(asm.issuer !== process.env.WEB_URL, "MCP origin differs from WEB_URL in this test");
	const unauthorized = fakeEvent({});
	await authenticateMcp(unauthorized).catch(() => setUnauthorizedHeader(unauthorized));
	assert(
		unauthorized._resHeaders["www-authenticate"] === `Bearer resource_metadata="${process.env.MCP_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`,
		`WWW-Authenticate points to MCP_PUBLIC_ORIGIN (${unauthorized._resHeaders["www-authenticate"]})`,
	);

	console.log("# return after login");
	assert(isSafeOauthReturn("/oauth/authorize?client_id=x"), "relative /oauth/authorize accepted");
	assert(isSafeOauthReturn(`${process.env.MCP_PUBLIC_ORIGIN}/oauth/authorize?client_id=x`), "absolute on MCP_PUBLIC_ORIGIN accepted");
	assert(!isSafeOauthReturn(`${process.env.WEB_URL}/oauth/authorize?client_id=x`), "absolute on WEB_URL (other port) refused");
	assert(!isSafeOauthReturn("https://evil.example/oauth/authorize?x=1"), "foreign origin refused");
	assert(!isSafeOauthReturn(`${process.env.MCP_PUBLIC_ORIGIN}/en/w/x`), "other path on MCP origin refused");
	assert(!isSafeOauthReturn("//evil.example/oauth/authorize?x"), "protocol-relative refused");
	assert(!isSafeOauthReturn("/oauth/authorize/../../evil"), "path without query refused");

	console.log("# dynamic registration");
	await expectThrow(
		() => registerClient({ client_name: "evil", redirect_uris: ["https://evil.example/cb"] }),
		/redirect_uri not allowed/,
		"foreign redirect_uri refused at registration",
	);
	await expectThrow(
		() => registerClient({ client_name: "evil", redirect_uris: ["http://localhost:1234/cb#frag"] }),
		/redirect_uri not allowed/,
		"redirect_uri with fragment refused",
	);
	const client = await registerClient({
		client_name: "Claude Code (test)",
		redirect_uris: ["http://localhost:1234/callback", "https://claude.ai/api/mcp/auth_callback"],
		token_endpoint_auth_method: "none",
	});
	assert(typeof client.client_id === "string" && !("client_secret" in client), "public client registered without secret");
	assert(isRedirectUriAllowed("http://localhost:60123/callback", client.redirect_uris), "loopback: port is not significant");
	assert(!isRedirectUriAllowed("http://localhost:60123/other", client.redirect_uris), "loopback: path is significant");
	assert(!isRedirectUriAllowed("https://claude.ai/api/mcp/other", client.redirect_uris), "remote callback: exact match only");

	console.log("# authorization");
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	const redirectUri = "http://localhost:51515/callback";
	await expectThrow(
		() => validateAuthorizeRequest({ response_type: "code", client_id: "nope", redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256" }),
		/Unknown client/,
		"unknown client refused before any redirect",
	);
	await expectThrow(
		() => validateAuthorizeRequest({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" }),
		/not registered/,
		"unregistered redirect_uri refused",
	);
	await expectThrow(
		() => validateAuthorizeRequest({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "plain" }),
		/PKCE/,
		"PKCE plain refused",
	);
	const { client: resolved } = await validateAuthorizeRequest({
		response_type: "code",
		client_id: client.client_id,
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${asm.issuer}/api/kurrier/mcp`,
	});
	const issue = () =>
		issueAuthorizationCode({ client: resolved, userId: a.user.id, redirectUri, codeChallenge: challenge, scope: "mcp:full" });

	console.log("# tokens");
	const badCode = await issue();
	await expectThrow(
		() => exchangeAuthorizationCode({ grant_type: "authorization_code", code: badCode, code_verifier: "wrong", client_id: client.client_id, redirect_uri: redirectUri }),
		/PKCE/,
		"wrong code_verifier refused",
	);
	await expectThrow(
		() => exchangeAuthorizationCode({ grant_type: "authorization_code", code: badCode, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
		/Invalid authorization code/,
		"a code is single-use, even after a failed attempt",
	);
	const code = await issue();
	await expectThrow(
		() => exchangeAuthorizationCode({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: "http://localhost:51515/other" }),
		/Invalid authorization code|redirect_uri mismatch/,
		"redirect_uri mismatch refused",
	);
	const noRedirect = await issue();
	await expectThrow(
		() => exchangeAuthorizationCode({ grant_type: "authorization_code", code: noRedirect, code_verifier: verifier, client_id: client.client_id }),
		/redirect_uri is required/,
		"redirect_uri is mandatory at the token endpoint",
	);
	const raced = await issue();
	const outcomes = await Promise.allSettled([1, 2, 3].map(() =>
		exchangeAuthorizationCode({ grant_type: "authorization_code", code: raced, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
	));
	assert(outcomes.filter((o) => o.status === "fulfilled").length === 1, "three concurrent exchanges of one code: exactly one succeeds");
	const code2 = await issue();
	const tokens = await exchangeAuthorizationCode({
		grant_type: "authorization_code",
		code: code2,
		code_verifier: verifier,
		client_id: client.client_id,
		redirect_uri: redirectUri,
	});
	assert(tokens.token_type === "Bearer" && tokens.expires_in === 30 * 24 * 3600, "access token issued, 30 days");

	console.log("# worker authentication + tools/list");
	const principal = await authenticateMcp(fakeEvent({ authorization: `Bearer ${tokens.access_token}` }));
	assert(principal.userId === a.user.id && principal.authType === "oauth", "Bearer token resolves to the user");
	const list = (await handleRpcBody(principal, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
	assert((list?.result?.tools?.length ?? 0) >= 15, `tools/list returns ${list?.result?.tools?.length} tools`);
	const who = (await handleRpcBody(principal, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "whoami", arguments: {} },
	})) as any;
	assert(who?.result?.structuredContent?.email === a.email, "whoami returns the OAuth user");
	await expectThrow(() => authenticateMcp(fakeEvent({ authorization: "Bearer not-a-token" })), /Invalid or expired/, "garbage token refused");
	await expectThrow(() => authenticateMcp(fakeEvent({})), /Provide/, "missing token refused");
	await expectThrow(
		() => authenticateMcp(fakeEvent({}, `/api/kurrier/mcp?api_key=${tokens.access_token}`)),
		/Provide/,
		"a token in the query string is ignored (never read from the URL)",
	);
	await expectThrow(
		() => registerClient({ client_name: "x", redirect_uris: ["http://localhost/cb"], grant_types: ["implicit"] }),
		/unsupported grant_types/,
		"grant_type implicit refused at registration",
	);
	await expectThrow(
		() => validateAuthorizeRequest({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:full admin" }),
		/unknown scope/,
		"unknown scope refused",
	);

	console.log("# refresh with rotation");
	const refreshed = await refreshAccessToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
	assert(refreshed.access_token !== tokens.access_token, "refresh issues a new access token");
	const replay = await refreshAccessToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
	assert(Boolean(replay.access_token), "old refresh token still accepted inside the grace window");
	await expectThrow(
		() => refreshAccessToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "other" }),
		/Client mismatch/,
		"refresh with another client refused",
	);
	const old = await authenticateMcp(fakeEvent({ authorization: `Bearer ${tokens.access_token}` })).catch((e) => e);
	assert(old instanceof Error, "rotated access token is no longer valid");
	const fresh = await authenticateMcp(fakeEvent({ authorization: `Bearer ${refreshed.access_token}` }));
	assert(fresh.userId === a.user.id, "new access token is valid");

	console.log("# replay of a refresh after the grace window: family revoked");
	const family = await refreshAccessToken({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: client.client_id });
	assert(Boolean(family.access_token), "second rotation issues a token");
	await db
		.update(mcpOauthAccessTokens)
		.set({ revokedAt: new Date(Date.now() - 120_000) })
		.where(eq(mcpOauthAccessTokens.refreshTokenHash, sha256(refreshed.refresh_token)));
	await expectThrow(
		() => refreshAccessToken({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: client.client_id }),
		/family revoked/,
		"rotated refresh token replayed after the grace window is refused",
	);
	await expectThrow(() => authenticateMcp(fakeEvent({ authorization: `Bearer ${family.access_token}` })), /Invalid or expired/, "the latest access token of the family is revoked too");
	await expectThrow(
		() => refreshAccessToken({ grant_type: "refresh_token", refresh_token: family.refresh_token, client_id: client.client_id }),
		/revoked/,
		"the latest refresh token of the family is revoked too",
	);

	console.log("# revocation");
	const tokens2 = await exchangeAuthorizationCode({ grant_type: "authorization_code", code: await issue(), code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri });
	await revokeToken(tokens2.access_token);
	await expectThrow(() => authenticateMcp(fakeEvent({ authorization: `Bearer ${tokens2.access_token}` })), /Invalid or expired/, "revoked access token refused");
	await expectThrow(
		() => refreshAccessToken({ grant_type: "refresh_token", refresh_token: tokens2.refresh_token, client_id: client.client_id }),
		/revoked/,
		"revoked refresh token refused (no grace window)",
	);

	console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
