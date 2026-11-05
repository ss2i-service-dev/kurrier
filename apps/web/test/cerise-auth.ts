// Connexion par Cerise (OI 10297) : domaines (avec l'arobase, pièges compris), state à temps
// constant, URL d'aller et de retour, lecture du profil /api/v1/me sur des fetch simulés
// (jeton refusé, Cerise injoignable, profil incomplet), règle de rattachement (lien, adresse,
// identité -> confirmation par mot de passe, création, ambiguïté), et câblage : ordre des
// contrôles dans la callback, lien posé seulement après un mot de passe vérifié, mot de passe
// toujours accepté (Cerise ne ferme rien), bouton sur la page de login.
// Aucune base, aucun réseau. Lancé par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/cerise-auth.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CERISE_CALLBACK_PATH,
	CERISE_DEFAULT_DOMAINS,
	CeriseError,
	ceriseAuthorizeUrl,
	ceriseBaseUrl,
	ceriseCallbackUrl,
	ceriseStateMatches,
	fetchCeriseProfile,
	isAllowedCeriseEmail,
	parseAllowedDomains,
	parseCeriseProfile,
	resolveCeriseAccount,
} from "../../../packages/common/src/cerise-auth";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		passed++;
	} catch (e) {
		console.error(`ECHEC ${name}`);
		throw e;
	}
}

const root = join(__dirname, "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

async function main() {
	await test("domaines par défaut", () => {
		assert.deepEqual(parseAllowedDomains(undefined), CERISE_DEFAULT_DOMAINS);
		assert.deepEqual(parseAllowedDomains(""), CERISE_DEFAULT_DOMAINS);
		assert.deepEqual(parseAllowedDomains(" @Exemple.fr , autre.fr "), ["exemple.fr", "autre.fr"]);
	});

	await test("domaine comparé avec l'arobase, en entier", () => {
		const d = CERISE_DEFAULT_DOMAINS;
		assert.equal(isAllowedCeriseEmail("samuel@ss2i-digital.fr", d), true);
		assert.equal(isAllowedCeriseEmail("Samuel@SS2I.CA", d), true);
		assert.equal(isAllowedCeriseEmail("hugo@ss2i-services.fr", d), true);
		assert.equal(isAllowedCeriseEmail("x@faux-ss2i.ca", d), false);
		assert.equal(isAllowedCeriseEmail("x@ss2i.ca.evil.fr", d), false);
		assert.equal(isAllowedCeriseEmail("x@sub.ss2i.ca", d), false);
		assert.equal(isAllowedCeriseEmail("x@ss2i.ca@evil.fr", d), false);
		assert.equal(isAllowedCeriseEmail("ss2i.ca", d), false);
		assert.equal(isAllowedCeriseEmail("a b@ss2i.ca", d), false);
		assert.equal(isAllowedCeriseEmail("sam.legros@gmail.com", d), false);
	});

	await test("base Cerise", () => {
		assert.equal(ceriseBaseUrl("https://c4.ss2i-services.fr/"), "https://c4.ss2i-services.fr");
		assert.equal(ceriseBaseUrl(""), null);
		assert.equal(ceriseBaseUrl(undefined), null);
		assert.equal(ceriseBaseUrl("pas une url"), null);
		assert.equal(ceriseBaseUrl("javascript:alert(1)"), null);
	});

	await test("URL d'aller et de retour", () => {
		const cb = ceriseCallbackUrl("https://mail.ss2i.ca", "abc");
		assert.equal(cb, `https://mail.ss2i.ca${CERISE_CALLBACK_PATH}?state=abc`);
		assert.equal(
			ceriseAuthorizeUrl("https://c4.ss2i-services.fr", cb),
			"https://c4.ss2i-services.fr/auth/courrier?callback=" + encodeURIComponent(cb),
		);
	});

	await test("state", () => {
		const s = "a".repeat(43);
		assert.equal(ceriseStateMatches(s, s), true);
		assert.equal(ceriseStateMatches(s, s.slice(1) + "b"), false);
		assert.equal(ceriseStateMatches(s, s + "a"), false);
		assert.equal(ceriseStateMatches(undefined, s), false);
		assert.equal(ceriseStateMatches(s, null), false);
		assert.equal(ceriseStateMatches("court", "court"), false);
	});

	await test("profil /api/v1/me", () => {
		const p = parseCeriseProfile({
			user: { id: 12, email: " Samuel@SS2i-Digital.fr ", firstname: "Samuel", lastname: "LEGROS", fullname: "Samuel LEGROS" },
		});
		assert.deepEqual(p, {
			id: "12",
			email: "samuel@ss2i-digital.fr",
			firstname: "Samuel",
			lastname: "LEGROS",
			fullname: "Samuel LEGROS",
		});
		assert.equal(parseCeriseProfile({ id: 12, email: "a@ss2i.ca" }), null);
		assert.equal(parseCeriseProfile({ user: { id: 0, email: "a@ss2i.ca" } }), null);
		assert.equal(parseCeriseProfile({ user: { id: 3 } }), null);
		assert.equal(parseCeriseProfile({ user: { id: "1 OR 1=1", email: "a@ss2i.ca" } }), null);
		assert.equal(parseCeriseProfile(null), null);
	});

	const fakeFetch = (status: number, body: unknown, seen?: { url?: string; auth?: string }) =>
		(async (url: string, init?: RequestInit) => {
			if (seen) {
				seen.url = url;
				seen.auth = (init?.headers as Record<string, string>)?.Authorization;
			}
			return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
		}) as unknown as typeof fetch;

	await test("échange du jeton", async () => {
		const seen: { url?: string; auth?: string } = {};
		const p = await fetchCeriseProfile(
			"https://c4.ss2i-services.fr",
			"42|abcDEF",
			fakeFetch(200, { user: { id: 7, email: "jb@ss2i-digital.fr" } }, seen),
		);
		assert.equal(p.id, "7");
		assert.equal(seen.url, "https://c4.ss2i-services.fr/api/v1/me");
		assert.equal(seen.auth, "Bearer 42|abcDEF");
	});

	const code = async (p: Promise<unknown>) => {
		try {
			await p;
		} catch (e) {
			assert.ok(e instanceof CeriseError);
			return e.code;
		}
		return "aucune erreur";
	};
	await test("erreurs d'échange", async () => {
		const b = "https://c4.ss2i-services.fr";
		assert.equal(await code(fetchCeriseProfile(b, "", fakeFetch(200, {}))), "token");
		assert.equal(await code(fetchCeriseProfile(b, "a b", fakeFetch(200, {}))), "token");
		assert.equal(await code(fetchCeriseProfile(b, "t", fakeFetch(401, {}))), "rejected");
		assert.equal(await code(fetchCeriseProfile(b, "t", fakeFetch(500, {}))), "unreachable");
		assert.equal(await code(fetchCeriseProfile(b, "t", fakeFetch(200, "<html>"))), "profile");
		assert.equal(await code(fetchCeriseProfile(b, "t", fakeFetch(200, { user: {} }))), "profile");
		const down = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		assert.equal(await code(fetchCeriseProfile(b, "t", down)), "unreachable");
	});

	await test("rattachement", () => {
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: ["u1"], userIdByEmail: "u2", identityOwnerIds: ["u3"] }),
			{ kind: "linked", userId: "u1" },
		);
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: ["u1", "u1"], userIdByEmail: null, identityOwnerIds: [] }),
			{ kind: "linked", userId: "u1" },
		);
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: ["u1", "u2"], userIdByEmail: null, identityOwnerIds: [] }),
			{ kind: "ambiguous" },
		);
		// JB, Hugo : même adresse dans Cerise et dans courrier.
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: [], userIdByEmail: "u2", identityOwnerIds: ["u2"] }),
			{ kind: "email", userId: "u2" },
		);
		// Samuel : compte samuel@ss2i.ca, Cerise samuel@ss2i-digital.fr (une identité du compte).
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: [], userIdByEmail: null, identityOwnerIds: ["u1"] }),
			{ kind: "confirm" },
		);
		// Boîte partagée : jamais d'ouverture sur la seule foi d'une identité.
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: [], userIdByEmail: null, identityOwnerIds: ["u1", "u2"] }),
			{ kind: "confirm" },
		);
		assert.deepEqual(
			resolveCeriseAccount({ linkedUserIds: [], userIdByEmail: null, identityOwnerIds: [] }),
			{ kind: "create" },
		);
	});

	await test("callback : ordre des contrôles", () => {
		const s = src("app/api/auth/cerise/callback/route.ts");
		const at = (needle: string) => {
			const i = s.indexOf(needle);
			assert.ok(i >= 0, `absent de la callback : ${needle}`);
			return i;
		};
		const state = at("ceriseStateMatches(");
		const fetchP = at("fetchCeriseProfile(");
		const domain = at("isAllowedCeriseEmail(");
		const resolve = at("findCeriseResolution(");
		const signIn = at("signInUserAndRedirect(user)");
		assert.ok(state < fetchP && fetchP < domain && domain < resolve && resolve < signIn);
		assert.ok(at("cookieStore.delete({ name: CERISE_STATE_COOKIE") < state, "state consommé avant contrôle");
		// signInUserAndRedirect lève NEXT_REDIRECT : jamais dans un try.
		assert.ok(!/try\s*{[^}]*signInUserAndRedirect/.test(s.replace(/\n/g, " ")));
		assert.ok(!/token.*(insert|set\(|console)/i.test(s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n").replace(/params\.get\("token"\)/g, "")),
			"le jeton Cerise n'est ni stocké ni journalisé");
	});

	await test("aller : state en cookie httpOnly et dans l'URL", () => {
		const s = src("app/api/auth/cerise/route.ts");
		assert.ok(s.includes("randomBytes(32)"));
		assert.ok(s.includes("httpOnly: true"));
		assert.ok(s.includes("ceriseCallbackUrl(getPublicEnv().WEB_URL, state)"));
		assert.ok(s.includes('status: 404'));
	});

	await test("mot de passe : toujours accepté, lien posé seulement après vérification", () => {
		const s = src("lib/actions/auth.ts");
		const verify = s.indexOf("argon2.verify(");
		const invalid = s.indexOf('return { error: "Invalid credentials" }', verify);
		const consume = s.indexOf("consumePendingCeriseLink(user.id)");
		const signIn = s.indexOf("signInUserAndRedirect(user, locale)");
		assert.ok(verify > 0 && invalid > verify && consume > invalid && signIn > consume);
		assert.ok(!s.includes("CERISE_ONLY"), "Cerise ne ferme pas le mot de passe (Samuel le 05/11)");
	});

	await test("page de login : bouton Cerise et lien en attente", () => {
		const form = src("components/auth/login-form.tsx");
		assert.ok(form.includes('href={"/api/auth/cerise"}'));
		assert.ok(form.includes("<Form action={formAction}>"), "le formulaire mot de passe reste");
		const page = src("app/[locale]/auth/login/page.tsx");
		assert.ok(page.includes("readPendingCeriseLink()"));
		assert.ok(page.includes("ceriseEnabled"));
	});

	await test("lien : un compte Cerise n'ouvre qu'un compte courrier", () => {
		const s = src("lib/cerise-account.ts");
		assert.ok(s.includes("existing.some((r) => r.userId !== userId)"));
		assert.ok(s.includes('setAudience(LINK_AUDIENCE)') && s.includes("audience: LINK_AUDIENCE"));
		assert.ok(s.includes('algorithms: ["HS256"]'));
	});

	console.log(`cerise-auth : ${passed} tests OK`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
