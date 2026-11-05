import {type NextRequest, NextResponse} from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { jwtVerify } from "jose";

const locales = ["en", "ko"];
const defaultLocale = "en";

function getRedirectLocale(request: NextRequest) {

	const pathname = request.nextUrl.pathname;
	// A static file of /public (e.g. /keyboard-shortcuts.js) has no locale.
	if (/\.[a-z0-9]+$/i.test(pathname)) return null;
	const pathnameHasLocale = locales.some(
		(locale) =>
			pathname === `/${locale}` ||
			pathname.startsWith(`/${locale}/`),
	);
	if (pathnameHasLocale) return null;
	const locale =
		request.cookies.get("locale")?.value ||
		request.headers.get("accept-language")?.split(",")[0]?.split("-")[0] ||
		defaultLocale;
	return locales.includes(locale) ? locale : defaultLocale;

}


export async function proxy(request: NextRequest) {

	// The routes of the MCP OAuth server (discovery and tokens) are outside the locale and
	// the session guard, like /api.
	if (
		request.nextUrl.pathname.startsWith("/api") ||
		request.nextUrl.pathname.startsWith("/oauth/") ||
		request.nextUrl.pathname.startsWith("/.well-known/")
	) {
		return await updateSession(request);
	}

	const redirectLocale = getRedirectLocale(request);

	if (redirectLocale) {
		const url = request.nextUrl.clone();
		url.pathname = `/${redirectLocale}${url.pathname}`;
		return NextResponse.redirect(url);
	}

	// Authentication guard. The "session" cookie lives 30 days, but nothing checked the
	// token before rendering: a missing or expired token reached the SQL queries and made
	// the page fail ("No workspace selected") instead of redirecting to login. It is decided
	// here, before any rendering.
	const protectedPath = PROTECTED.exec(request.nextUrl.pathname);
	if (protectedPath && !(await hasValidSession(request))) {
		const url = request.nextUrl.clone();
		url.pathname = `/${protectedPath[1]}/auth/login`;
		url.search = "";
		const response = NextResponse.redirect(url);
		response.cookies.delete("session");
		return response;
	}

	// Valid session but workspace cookies missing (browser closed: they had no lifetime) or
	// belonging to another workspace than the one in the URL. Every SQL query used to throw
	// "No workspace selected" and each reload showed the same error. The resume route sets
	// them again, then returns to this URL. GET only: a server action (POST) cannot be
	// redirected.
	const workspaceInUrl = WORKSPACE_IN_URL.exec(request.nextUrl.pathname)?.[1];
	if (
		workspaceInUrl &&
		request.method === "GET" &&
		!request.headers.get("next-action") &&
		(!request.cookies.get("workspaceId")?.value ||
			request.cookies.get("workspacePublicId")?.value !== workspaceInUrl)
	) {
		const url = request.nextUrl.clone();
		url.pathname = "/api/auth/resume";
		url.search = "";
		url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
		return NextResponse.redirect(url);
	}

	return await updateSession(request);
}

const PROTECTED = /^\/(en|ko)\/w(?:\/|$)/;
const WORKSPACE_IN_URL = /^\/(?:en|ko)\/w\/([^/]+)/;

async function hasValidSession(request: NextRequest) {
	const token = request.cookies.get("session")?.value;
	if (!token) return false;
	const secret = process.env.JWT_SECRET;
	if (!secret) return false;
	try {
		const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
		// A token with an audience is not a session.
		return Boolean(payload.sub) && payload.aud === undefined;
	} catch {
		return false;
	}
}

export const config = {
	matcher: [
		/*
		 * Match all request paths except for the ones starting with:
		 * - _next/static (static files)
		 * - _next/image (image optimization files)
		 * - favicon.ico (favicon file)
		 * Feel free to modify this pattern to include more paths.
		 */
		"/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
	],
};
