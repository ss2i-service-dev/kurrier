// ss2i : connexion par Cerise (pont SSO oauth-bridge de SS2i Services), OI 10297.
//
// Cerise est une seconde porte, à côté du mot de passe courrier : un compte peut avoir les
// deux (Samuel le 05/11 : « il faut que les deux continuent à fonctionner [...] il faut
// qu'un compte puisse être attaché à plusieurs moyens d'authentification »). Le lien entre
// un compte courrier et un compte Cerise vit dans auth_accounts (fournisseur « cerise »),
// comme celui de Google.
//
// Flux : GET {CERISE_URL}/auth/courrier?callback=<retour>?state=<aléa> -> consentement dans
// Cerise (et sa double authentification si l'utilisateur l'a activée) -> retour
// <retour>?state=<aléa>&token=<jeton Sanctum 5 min> -> GET {CERISE_URL}/api/v1/me -> session
// courrier. Le jeton n'est pas gardé : courrier n'a besoin que de savoir qui se connecte.
//
// Ce module ne touche ni la base ni Next : logique pure, testée par apps/web/test/cerise-auth.ts.

import { timingSafeEqual } from "node:crypto";

export const CERISE_APP_SLUG = "courrier";
export const CERISE_PROVIDER_NAME = "cerise";
export const CERISE_CALLBACK_PATH = "/api/auth/cerise/callback";
// Préfixe __Host- : cookie posé par mail.ss2i.ca seul, en https, sur path=/ ; un sous-domaine
// voisin ne peut ni l'écraser ni en injecter un (login-CSRF par cookie).
export const CERISE_STATE_COOKIE = "__Host-cerise_state";
export const CERISE_LINK_COOKIE = "__Host-cerise_link";
// Champ du formulaire de login qui accepte explicitement le lien en attente.
export const CERISE_LINK_FIELD = "cerise_link_confirm";
export const CERISE_STATE_TTL_SECONDS = 10 * 60;
export const CERISE_LINK_TTL_SECONDS = 15 * 60;
export const CERISE_FETCH_TIMEOUT_MS = 10_000;

// Domaines des salariés de SS2i Services. Même liste que les autres outils internes.
export const CERISE_DEFAULT_DOMAINS = ["ss2i.ca", "ss2i-digital.fr", "ss2i-services.fr"];

export type CeriseProfile = {
	id: string;
	/** Application pour laquelle Cerise a émis le jeton (/api/v1/me, token.name). */
	tokenName?: string | null;
	email: string;
	firstname: string | null;
	lastname: string | null;
	fullname: string | null;
};

export class CeriseError extends Error {
	constructor(
		public readonly code:
			| "config"
			| "state"
			| "token"
			| "unreachable"
			| "rejected"
			| "profile"
			| "audience"
			| "domain",
		message: string,
	) {
		super(message);
		this.name = "CeriseError";
	}
}

/** Base de Cerise sans « / » final, ou null si la connexion par Cerise n'est pas configurée. */
export function ceriseBaseUrl(raw: string | undefined | null): string | null {
	const v = (raw ?? "").trim().replace(/\/+$/, "");
	if (!v) return null;
	try {
		const u = new URL(v);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return v;
	} catch {
		return null;
	}
}

export function parseAllowedDomains(raw: string | undefined | null): string[] {
	const list = (raw ?? "")
		.split(",")
		.map((d) => d.trim().toLowerCase().replace(/^@/, ""))
		.filter(Boolean);
	return list.length ? list : CERISE_DEFAULT_DOMAINS;
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Domaine comparé avec l'arobase, en entier : « x@faux-ss2i.ca » et « x@ss2i.ca.evil.fr »
 * ne passent pas. Une seule arobase, pas d'espace.
 */
export function isAllowedCeriseEmail(email: string, domains: string[]): boolean {
	const m = /^[^@\s]+@([^@\s]+)$/.exec(normalizeEmail(email));
	if (!m) return false;
	return domains.map((d) => d.toLowerCase()).includes(m[1]);
}

export function ceriseCallbackUrl(webUrl: string, state: string): string {
	const u = new URL(CERISE_CALLBACK_PATH, webUrl);
	u.searchParams.set("state", state);
	return u.toString();
}

export function ceriseAuthorizeUrl(base: string, callback: string): string {
	return `${base}/auth/${CERISE_APP_SLUG}?callback=${encodeURIComponent(callback)}`;
}

/** Comparaison à temps constant du state de l'URL et de celui du cookie. */
export function ceriseStateMatches(cookieState: string | undefined | null, queryState: string | undefined | null): boolean {
	if (!cookieState || !queryState) return false;
	if (cookieState.length < 32) return false;
	const a = Buffer.from(cookieState);
	const b = Buffer.from(queryState);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Lit la réponse de GET /api/v1/me (clé « user »). null si elle n'a pas la forme attendue. */
export function parseCeriseProfile(json: unknown): CeriseProfile | null {
	const user = (json as { user?: Record<string, unknown> } | null)?.user;
	if (!user || typeof user !== "object") return null;
	const rawId = user.id;
	const id =
		typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0
			? String(rawId)
			: typeof rawId === "string" && /^[0-9A-Za-z-]+$/.test(rawId)
				? rawId
				: null;
	const email = typeof user.email === "string" ? normalizeEmail(user.email) : "";
	if (!id || !email || !email.includes("@")) return null;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
	const token = (json as { token?: { name?: unknown } }).token;
	return {
		id,
		tokenName: typeof token?.name === "string" ? token.name : null,
		email,
		firstname: str(user.firstname),
		lastname: str(user.lastname),
		fullname: str(user.fullname),
	};
}

/** Échange le jeton contre le profil. Toute anomalie lève une CeriseError. */
export async function fetchCeriseProfile(
	base: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CeriseProfile> {
	if (!token || token.length > 512 || /\s/.test(token)) {
		throw new CeriseError("token", "Jeton Cerise absent ou invalide");
	}
	let res: Response;
	try {
		res = await fetchImpl(`${base}/api/v1/me`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(CERISE_FETCH_TIMEOUT_MS),
		});
	} catch {
		throw new CeriseError("unreachable", "Cerise ne répond pas");
	}
	if (res.status === 401 || res.status === 403) {
		throw new CeriseError("rejected", `Cerise refuse le jeton (${res.status})`);
	}
	if (!res.ok) {
		throw new CeriseError("unreachable", `Cerise répond ${res.status}`);
	}
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new CeriseError("profile", "Profil Cerise illisible");
	}
	const profile = parseCeriseProfile(json);
	if (!profile) throw new CeriseError("profile", "Profil Cerise incomplet");
	// Tous les jetons du pont ont les pleins droits et la plupart n'expirent pas (Docator,
	// Lore...) : un jeton émis pour une autre app n'ouvre pas courrier.
	if (profile.tokenName !== CERISE_APP_SLUG) {
		throw new CeriseError("audience", `Jeton emis pour « ${profile.tokenName ?? "?"} », pas pour courrier`);
	}
	return profile;
}

/**
 * Comment ouvrir la session une fois Cerise passé, dans cet ordre :
 * - « linked » : ce compte Cerise est déjà lié à un compte courrier, session ouverte ;
 * - « confirm » : un compte courrier a cette adresse, comme adresse de connexion (JB, Hugo)
 *   ou seulement comme identité d'envoi (Samuel : compte samuel@ss2i.ca, Cerise
 *   samuel@ss2i-digital.fr). Le PREMIER lien se confirme une fois par le mot de passe
 *   courrier de ce compte : l'adresse transmise par Cerise ne suffit jamais à ouvrir un
 *   compte existant (revue de sécurité du 05/11 : elle était modifiable par chacun dans son
 *   profil Cerise, et une boîte partagée porte l'adresse d'un autre) ;
 * - « create » : aucun compte ni identité à cette adresse, compte créé et lié ;
 * - « ambiguous » : le compte Cerise est lié à plusieurs comptes courrier, rien n'est ouvert.
 */
export type CeriseResolution =
	| { kind: "linked"; userId: string }
	| { kind: "confirm" }
	| { kind: "create" }
	| { kind: "ambiguous" };

export function resolveCeriseAccount(input: {
	linkedUserIds: string[];
	userIdByEmail: string | null;
	identityOwnerIds: string[];
}): CeriseResolution {
	const linked = Array.from(new Set(input.linkedUserIds));
	if (linked.length > 1) return { kind: "ambiguous" };
	if (linked.length === 1) return { kind: "linked", userId: linked[0] };
	if (input.userIdByEmail || input.identityOwnerIds.length > 0) return { kind: "confirm" };
	return { kind: "create" };
}
