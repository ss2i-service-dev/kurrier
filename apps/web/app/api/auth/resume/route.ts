import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { isSignedIn } from "@/lib/actions/auth";
import { getWorkspaceRedirectUrl } from "@/lib/auth-session";
import { withLocale } from "@/lib/utils";

// Resume a still-valid session: redirects to the inbox of the default identity (or
// the workspace overview), with the /w/<id>/ segment that the auth layout used to
// omit (guaranteed 404). This is a route and not the layout because the workspace
// context is set in cookies, which a server component may not do.
//
// ?next=<path> (set by the proxy when the workspace cookies are missing): once the
// cookies are set again, return to the requested page instead of the inbox, only if
// it is inside the user's workspace (relative path, no open redirect). Otherwise the
// usual target.
export async function GET(request: NextRequest) {
	const cookieStore = await cookies();
	const locale = cookieStore.get("locale")?.value === "ko" ? "ko" : "en";
	const user = await isSignedIn();
	const target = user
		? await getWorkspaceRedirectUrl(user as Parameters<typeof getWorkspaceRedirectUrl>[0])
		: "/auth/login";
	if (target === "/auth/login") {
		// Session without a workspace: drop it, otherwise login -> resume -> login loops.
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
