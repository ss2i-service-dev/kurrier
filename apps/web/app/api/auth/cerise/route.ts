// ss2i : connexion par Cerise, aller (OI 10297). Pose un state aléatoire en cookie httpOnly
// et le passe aussi dans l'URL de retour (Cerise garde les paramètres de la callback) : le
// retour n'est accepté que si les deux concordent, ce qui ferme le login-CSRF (Cerise ne
// propage pas de « state » OAuth). Sans CERISE_URL : 404.
import {
	CERISE_STATE_COOKIE,
	CERISE_STATE_TTL_SECONDS,
	ceriseAuthorizeUrl,
	ceriseBaseUrl,
	ceriseCallbackUrl,
} from "@common/cerise-auth";
import { getPublicEnv, getServerEnv } from "@schema";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET() {
	const base = ceriseBaseUrl(getServerEnv().CERISE_URL);
	if (!base) return new NextResponse("Not found", { status: 404 });

	const state = randomBytes(32).toString("base64url");
	const cookieStore = await cookies();
	cookieStore.set(CERISE_STATE_COOKIE, state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/api/auth/cerise",
		maxAge: CERISE_STATE_TTL_SECONDS,
	});

	const callback = ceriseCallbackUrl(getPublicEnv().WEB_URL, state);
	return NextResponse.redirect(ceriseAuthorizeUrl(base, callback));
}
