import "server-only";

// ss2i : comptes courrier et connexion par Cerise (OI 10297). Logique pure dans
// @common/cerise-auth ; ici la base (auth_accounts, auth_providers, identities, users) et le
// cookie de lien en attente. Module serveur, pas un module d'actions : rien n'y est appelable
// depuis le navigateur.
import {
	CERISE_LINK_COOKIE,
	CERISE_LINK_TTL_SECONDS,
	CERISE_PROVIDER_NAME,
	type CeriseProfile,
	type CeriseResolution,
	normalizeEmail,
	resolveCeriseAccount,
} from "@common/cerise-auth";
import { authAccounts, authProviders, db, identities, users, workspaces } from "@db";
import { getServerEnv } from "@schema";
import { and, eq, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";

const LINK_AUDIENCE = "courrier:cerise-link";

function secret() {
	return new TextEncoder().encode(getServerEnv().JWT_SECRET);
}

export async function findCeriseResolution(profile: CeriseProfile): Promise<CeriseResolution> {
	const linked = await db
		.select({ userId: authAccounts.userId })
		.from(authAccounts)
		.innerJoin(authProviders, eq(authProviders.id, authAccounts.providerId))
		.where(
			and(
				eq(authProviders.name, CERISE_PROVIDER_NAME),
				eq(authAccounts.providerUserId, profile.id),
			),
		);

	const email = normalizeEmail(profile.email);
	const [byEmail] = await db
		.select({ id: users.id })
		.from(users)
		.where(sql`lower(${users.email}) = ${email}`)
		.limit(2);

	const owners = await db
		.selectDistinct({ ownerId: identities.ownerId })
		.from(identities)
		.where(and(eq(identities.kind, "email"), sql`lower(${identities.value}) = ${email}`));

	return resolveCeriseAccount({
		linkedUserIds: linked.map((r) => r.userId),
		userIdByEmail: byEmail?.id ?? null,
		identityOwnerIds: owners.map((r) => r.ownerId),
	});
}

/**
 * Lie le compte Cerise au compte courrier (ligne auth_accounts, fournisseur « cerise » du
 * workspace de l'utilisateur, créé au besoin). Refuse si ce compte Cerise est déjà lié à un
 * AUTRE compte courrier : un compte Cerise n'ouvre qu'un seul compte.
 */
export async function linkCeriseAccount(userId: string, profile: CeriseProfile): Promise<boolean> {
	const existing = await db
		.select({ userId: authAccounts.userId })
		.from(authAccounts)
		.innerJoin(authProviders, eq(authProviders.id, authAccounts.providerId))
		.where(
			and(
				eq(authProviders.name, CERISE_PROVIDER_NAME),
				eq(authAccounts.providerUserId, profile.id),
			),
		);
	if (existing.some((r) => r.userId !== userId)) return false;
	if (existing.length > 0) return true;

	const [workspace] = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(eq(workspaces.ownerId, userId))
		.limit(1);
	if (!workspace) return false;

	let [provider] = await db
		.select({ id: authProviders.id })
		.from(authProviders)
		.where(
			and(
				eq(authProviders.workspaceId, workspace.id),
				eq(authProviders.name, CERISE_PROVIDER_NAME),
			),
		);
	if (!provider) {
		[provider] = await db
			.insert(authProviders)
			.values({
				ownerId: userId,
				workspaceId: workspace.id,
				name: CERISE_PROVIDER_NAME,
				type: "oauth-bridge",
				issuerUrl: getServerEnv().CERISE_URL ?? "",
				clientId: "courrier",
				enabled: true,
				metaData: {},
			})
			.onConflictDoNothing()
			.returning({ id: authProviders.id });
		if (!provider) {
			[provider] = await db
				.select({ id: authProviders.id })
				.from(authProviders)
				.where(
					and(
						eq(authProviders.workspaceId, workspace.id),
						eq(authProviders.name, CERISE_PROVIDER_NAME),
					),
				);
		}
	}
	if (!provider) return false;

	const inserted = await db
		.insert(authAccounts)
		.values({
			userId,
			providerId: provider.id,
			providerUserId: profile.id,
			email: normalizeEmail(profile.email),
			emailVerified: true,
			rawProfile: {
				id: profile.id,
				email: profile.email,
				firstname: profile.firstname,
				lastname: profile.lastname,
			},
			workspaceId: workspace.id,
		})
		.onConflictDoNothing()
		.returning({ id: authAccounts.id });
	return inserted.length > 0;
}

/** Le compte a-t-il cette adresse, comme adresse de connexion ou comme identité d'envoi ? */
export async function userOwnsAddress(userId: string, email: string): Promise<boolean> {
	const e = normalizeEmail(email);
	const [u] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, userId), sql`lower(${users.email}) = ${e}`))
		.limit(1);
	if (u) return true;
	const [i] = await db
		.select({ id: identities.id })
		.from(identities)
		.where(
			and(
				eq(identities.ownerId, userId),
				eq(identities.kind, "email"),
				sql`lower(${identities.value}) = ${e}`,
			),
		)
		.limit(1);
	return !!i;
}

/**
 * Lien en attente (cas « confirm ») : profil Cerise signé, 15 min, cookie httpOnly. Le
 * prochain login par mot de passe réussi le consomme et pose le lien.
 */
export async function setPendingCeriseLink(profile: CeriseProfile) {
	const token = await new SignJWT({
		email: profile.email,
		firstname: profile.firstname,
		lastname: profile.lastname,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(profile.id)
		.setAudience(LINK_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(`${CERISE_LINK_TTL_SECONDS}s`)
		.sign(secret());
	const cookieStore = await cookies();
	cookieStore.set(CERISE_LINK_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/",
		maxAge: CERISE_LINK_TTL_SECONDS,
	});
}

export async function readPendingCeriseLink(): Promise<CeriseProfile | null> {
	const cookieStore = await cookies();
	const raw = cookieStore.get(CERISE_LINK_COOKIE)?.value;
	if (!raw) return null;
	try {
		const { payload } = await jwtVerify(raw, secret(), {
			audience: LINK_AUDIENCE,
			algorithms: ["HS256"],
		});
		if (!payload.sub || typeof payload.email !== "string") return null;
		return {
			id: payload.sub,
			email: payload.email,
			firstname: typeof payload.firstname === "string" ? payload.firstname : null,
			lastname: typeof payload.lastname === "string" ? payload.lastname : null,
			fullname: null,
		};
	} catch {
		return null;
	}
}

export async function clearPendingCeriseLink() {
	const cookieStore = await cookies();
	cookieStore.delete(CERISE_LINK_COOKIE);
}

/**
 * Appelé par le login par mot de passe, une fois le mot de passe vérifié. Le cookie est
 * toujours effacé. Le lien ne se pose que si l'utilisateur l'a demandé explicitement (case du
 * formulaire, affichée par la bannière) ET que le compte a l'adresse transmise par Cerise
 * (adresse de connexion ou identité, relue en base) : un cookie oublié sur un poste partagé
 * ne lie pas le Cerise de A au compte de B.
 */
export async function consumePendingCeriseLink(userId: string, confirmed: boolean) {
	const pending = await readPendingCeriseLink();
	await clearPendingCeriseLink();
	if (!pending || !confirmed) return;
	if (!(await userOwnsAddress(userId, pending.email))) {
		console.warn(`[cerise] lien refuse : ${pending.email} n'est pas une adresse de user ${userId}`);
		return;
	}
	const ok = await linkCeriseAccount(userId, pending);
	console.info(
		`[cerise] lien ${ok ? "pose" : "non pose (deja lie ailleurs ou conflit)"} : cerise ${pending.id} (${pending.email}) -> user ${userId}`,
	);
}
