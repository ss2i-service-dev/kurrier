// ss2i : connexion par Cerise, retour (OI 10297). Ordre des contrôles : state (cookie et
// URL concordants, cookie consommé), jeton échangé contre le profil sur /api/v1/me, domaine
// de l'adresse AVANT toute recherche ou création de compte, puis rattachement
// (cf. resolveCeriseAccount). La session s'ouvre par signInUserAndRedirect, le même chemin
// que le mot de passe : retour vers le consentement de l'MCP (cookie oauth_return) compris.
// Le jeton Cerise n'est conservé nulle part.
import {
	CERISE_STATE_COOKIE,
	CeriseError,
	ceriseBaseUrl,
	ceriseStateMatches,
	fetchCeriseProfile,
	isAllowedCeriseEmail,
	parseAllowedDomains,
} from "@common/cerise-auth";
import { db, users } from "@db";
import { getPublicEnv, getServerEnv } from "@schema";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createUserWithWorkspace, signInUserAndRedirect } from "@/lib/auth-session";
import {
	clearPendingCeriseLink,
	findCeriseResolution,
	linkCeriseAccount,
	setPendingCeriseLink,
} from "@/lib/cerise-account";

export const dynamic = "force-dynamic";

function toLogin(message: string) {
	const url = new URL("/auth/login", getPublicEnv().WEB_URL);
	url.searchParams.set("message", message);
	return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
	const env = getServerEnv();
	const base = ceriseBaseUrl(env.CERISE_URL);
	if (!base) return new NextResponse("Not found", { status: 404 });

	const cookieStore = await cookies();
	const cookieState = cookieStore.get(CERISE_STATE_COOKIE)?.value;
	cookieStore.delete({ name: CERISE_STATE_COOKIE, path: "/api/auth/cerise" });

	const params = request.nextUrl.searchParams;
	if (!ceriseStateMatches(cookieState, params.get("state"))) {
		console.warn("[cerise] retour refuse : state absent ou different");
		return toLogin("cerise_state");
	}

	let profile;
	try {
		profile = await fetchCeriseProfile(base, params.get("token") ?? "");
	} catch (e) {
		const code = e instanceof CeriseError ? e.code : "unreachable";
		console.warn(`[cerise] profil non obtenu (${code}) : ${(e as Error).message}`);
		return toLogin(code === "rejected" || code === "token" ? "cerise_rejected" : "cerise_unreachable");
	}

	if (!isAllowedCeriseEmail(profile.email, parseAllowedDomains(env.CERISE_ALLOWED_DOMAINS))) {
		console.warn(`[cerise] domaine refuse : ${profile.email} (cerise ${profile.id})`);
		return toLogin("cerise_domain");
	}

	const resolution = await findCeriseResolution(profile);
	let userId: string;

	switch (resolution.kind) {
		case "ambiguous":
			console.warn(`[cerise] cerise ${profile.id} lie a plusieurs comptes, rien n'est ouvert`);
			return toLogin("cerise_ambiguous");
		case "confirm":
			await setPendingCeriseLink(profile);
			console.info(`[cerise] ${profile.email} : confirmation par mot de passe demandee`);
			return toLogin("cerise_confirm");
		case "linked":
			userId = resolution.userId;
			break;
		case "email": {
			userId = resolution.userId;
			const ok = await linkCeriseAccount(userId, profile);
			if (!ok) return toLogin("cerise_ambiguous");
			console.info(`[cerise] lien pose par adresse : cerise ${profile.id} -> user ${userId}`);
			break;
		}
		case "create": {
			// Mot de passe aléatoire jamais communiqué : le compte s'ouvre par Cerise, et un
			// départ de la société en ferme l'accès en fermant Cerise.
			const created = await createUserWithWorkspace({
				email: profile.email,
				passwordHash: await argon2.hash(randomBytes(32).toString("base64url")),
				workspaceName: "Default Workspace",
			});
			if (!created || "error" in created) {
				console.warn(`[cerise] creation impossible pour ${profile.email}`);
				return toLogin("cerise_unreachable");
			}
			userId = created.id;
			await linkCeriseAccount(userId, profile);
			console.info(`[cerise] compte cree : ${profile.email} (cerise ${profile.id}) -> user ${userId}`);
			break;
		}
	}

	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) return toLogin("cerise_unreachable");

	await clearPendingCeriseLink();
	// Lève NEXT_REDIRECT : hors de tout try/catch.
	await signInUserAndRedirect(user);
	return NextResponse.redirect(new URL("/", getPublicEnv().WEB_URL));
}
