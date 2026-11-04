import {type NextRequest, NextResponse} from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { jwtVerify } from "jose";

const locales = ["en", "ko"];
const defaultLocale = "en";

function getRedirectLocale(request: NextRequest) {

	const pathname = request.nextUrl.pathname;
	// Un fichier statique de /public (ex. /ss2i-shortcuts.js) n'a pas de locale.
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

	// ss2i : les routes du serveur OAuth de l'MCP courrier (decouverte et jetons) sont
	// hors locale et hors garde de session, comme /api.
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

	// Garde d'authentification. Le cookie « session » vit 30 jours, mais rien ne
	// verifiait le jeton avant le rendu : un jeton absent ou perime arrivait
	// jusqu'aux requetes SQL et faisait tomber la page (« No workspace selected »)
	// au lieu de renvoyer au login. On tranche ici, avant tout rendu.
	const protectedPath = PROTECTED.exec(request.nextUrl.pathname);
	if (protectedPath && !(await hasValidSession(request))) {
		const url = request.nextUrl.clone();
		url.pathname = `/${protectedPath[1]}/auth/login`;
		url.search = "";
		const response = NextResponse.redirect(url);
		response.cookies.delete("session");
		return response;
	}

	// ss2i : session valide mais cookies du workspace absents (fermeture de Chrome : ils
	// etaient sans duree) ou d'un autre workspace que celui de l'URL. Toutes les requetes
	// SQL levaient « No workspace selected » et chaque F5 rechargeait la meme erreur
	// (Samuel, 04/11). La route de reprise les repose puis revient sur cette URL. GET
	// seulement : une action serveur (POST) ne se redirige pas.
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
		return Boolean(payload.sub);
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
