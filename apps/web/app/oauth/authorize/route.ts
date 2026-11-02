import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSignedIn } from "@/lib/actions/auth";
import {
	AUTHORIZE_PARAM_KEYS,
	type AuthorizeParams,
	OAuthError,
	baseUrl,
	consentPage,
	mcpPublicOrigin,
	issueAuthorizationCode,
	redirectWithParams,
	validateAuthorizeRequest,
} from "@/lib/mcp-oauth";
import { oauthErrorResponse } from "@/lib/mcp-oauth-http";

// Endpoint d'autorisation : derriere la session de l'application (cookie « session »).
// GET sans session -> login, avec retour ici (cookie oauth_return lu par
// signInUserAndRedirect) ; GET avec session -> page de consentement ; POST -> code
// d'autorisation renvoye au redirect_uri, ou access_denied.

const RETURN_COOKIE = "oauth_return";
const CSRF_COOKIE = "oauth_csrf";

const cookieOpts = {
	httpOnly: true,
	secure: process.env.NODE_ENV === "production",
	sameSite: "lax" as const,
	path: "/",
	maxAge: 10 * 60,
};

function pick(source: { get(key: string): string | null }): AuthorizeParams {
	const params: AuthorizeParams = {};
	for (const key of AUTHORIZE_PARAM_KEYS) {
		const v = source.get(key);
		if (v !== null && v !== "") params[key] = v;
	}
	return params;
}

export async function GET(request: Request) {
	// request.url ne sert qu'au chemin et a la requete : son origine est l'adresse
	// d'ecoute du conteneur (0.0.0.0:3000), jamais une adresse publique.
	const url = new URL(request.url);
	const params = pick(url.searchParams);
	const user = await isSignedIn();
	const cookieStore = await cookies();
	if (!user) {
		// Login sur WEB_URL (443), retour ici sur MCP_PUBLIC_ORIGIN (8443) : les cookies
		// ne sont pas cloisonnes par port, la session posee sur 443 est vue sur 8443.
		const locale = cookieStore.get("locale")?.value === "ko" ? "ko" : "en";
		const response = NextResponse.redirect(`${baseUrl()}/${locale}/auth/login`);
		response.cookies.set(RETURN_COOKIE, `${mcpPublicOrigin()}${url.pathname}${url.search}`, cookieOpts);
		return response;
	}
	try {
		const { client } = await validateAuthorizeRequest(params);
		const csrf = crypto.randomBytes(24).toString("base64url");
		const response = new NextResponse(
			consentPage({ clientName: client.clientName, userEmail: user.email, params, csrf }),
			{
				status: 200,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					// Jamais dans un cadre : pas de clickjacking du bouton Autoriser.
					"X-Frame-Options": "DENY",
					"Content-Security-Policy": "frame-ancestors 'none'",
				},
			},
		);
		response.cookies.set(CSRF_COOKIE, csrf, cookieOpts);
		response.cookies.delete(RETURN_COOKIE);
		return response;
	} catch (err) {
		return oauthErrorResponse(err);
	}
}

export async function POST(request: Request) {
	const user = await isSignedIn();
	if (!user) {
		return oauthErrorResponse(new OAuthError("access_denied", "Not signed in", 401));
	}
	const form = await request.formData().catch(() => null);
	if (!form) return oauthErrorResponse(new OAuthError("invalid_request", "Form body expected"));
	const params = pick({ get: (k) => (typeof form.get(k) === "string" ? String(form.get(k)) : null) });
	const cookieStore = await cookies();
	const csrfCookie = cookieStore.get(CSRF_COOKIE)?.value ?? "";
	const csrfForm = String(form.get("csrf") ?? "");
	if (!csrfCookie || csrfCookie !== csrfForm) {
		return oauthErrorResponse(new OAuthError("invalid_request", "Invalid or expired consent form"));
	}
	try {
		// Client et redirect_uri sont verifies avant toute redirection, refus compris.
		const { client, redirectUri } = await validateAuthorizeRequest(params);
		const decision = String(form.get("decision") ?? "");
		let location: string;
		if (decision !== "approve") {
			location = redirectWithParams(redirectUri, {
				error: "access_denied",
				error_description: "Access denied by the user",
				state: params.state,
			});
		} else {
			const code = await issueAuthorizationCode({
				client,
				userId: user.id,
				redirectUri,
				codeChallenge: String(params.code_challenge),
				scope: params.scope,
				resource: params.resource,
			});
			location = redirectWithParams(redirectUri, { code, state: params.state });
		}
		const response = NextResponse.redirect(location, 302);
		response.cookies.delete(CSRF_COOKIE);
		return response;
	} catch (err) {
		return oauthErrorResponse(err);
	}
}
