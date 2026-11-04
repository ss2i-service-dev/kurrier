import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { isSignedIn } from "@/lib/actions/auth";
import { getWorkspaceRedirectUrl } from "@/lib/auth-session";
import { withLocale } from "@/lib/utils";

// Reprise d'une session encore valide : envoie vers la boite de reception de
// l'identite par defaut (ou la vue d'ensemble du workspace), avec le segment
// /w/<id>/ que le layout d'authentification amont oubliait (404 assuree).
// C'est une route et non le layout, parce que le contexte du workspace se pose
// en cookies, ce qu'un composant serveur n'a pas le droit de faire.
//
// ss2i : ?next=<chemin> (pose par le proxy quand les cookies du workspace manquent) :
// une fois les cookies reposes, on revient sur la page demandee au lieu de l'Inbox,
// seulement si elle est dans le workspace de l'utilisateur (chemin relatif, pas d'open
// redirect). Sinon, cible habituelle.
export async function GET(request: NextRequest) {
	const cookieStore = await cookies();
	const locale = cookieStore.get("locale")?.value === "ko" ? "ko" : "en";
	const user = await isSignedIn();
	const target = user
		? await getWorkspaceRedirectUrl(user as Parameters<typeof getWorkspaceRedirectUrl>[0])
		: "/auth/login";
	if (target === "/auth/login") {
		// Session sans workspace : on la coupe, sinon login -> reprise -> login en boucle.
		cookieStore.delete("session");
		redirect(withLocale(locale, target));
	}
	const next = safeNext(request.nextUrl.searchParams.get("next"), target);
	redirect(next ?? withLocale(locale, target));
}

function safeNext(next: string | null, target: string) {
	if (!next) return null;
	const workspace = /^\/w\/([^/?#]+)/.exec(target)?.[1];
	if (!workspace) return null;
	const m = /^\/(en|ko)\/w\/([^/?#]+)(?:[/?#]|$)/.exec(next);
	if (!m || m[2] !== workspace) return null;
	if (next.includes("//") || next.includes("\\")) return null;
	return next;
}
