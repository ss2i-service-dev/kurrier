import "server-only";

// ss2i (controle d'acces) : creation de compte, ouverture de session et contexte du
// workspace. Ces fonctions etaient exportees par lib/actions/auth.ts et workspace.ts,
// fichiers "use server" : chacune etait donc une action appelable par n'importe qui
// (createSessionForUser(userId) ouvrait une session pour n'importe quel utilisateur,
// createUserWithWorkspace contournait DISABLE_SIGNUP, updateWorkSpaceContext posait les
// cookies d'un workspace quelconque). Ce module n'est pas un module d'actions : seuls le
// serveur (login, signup, OIDC, reprise de session, changement de workspace) les appelle.
import { APP_VERSION } from "@common";
import {
	db,
	identities,
	UserEntity,
	users,
	workspaceMembers,
	WorkspaceRolesListType,
	workspaces,
} from "@db";
import { getServerEnv } from "@schema";
import { Queue, QueueEvents } from "bullmq";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { isSafeOauthReturn } from "@/lib/mcp-oauth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getRedis } from "@/lib/actions/get-redis";
import { withLocale } from "@/lib/utils";

const initProviders = async (userId: string, workspaceId: string) => {
	const { REDIS_PASSWORD, REDIS_HOST, REDIS_PORT } = getServerEnv();

	const redisConnection = {
		connection: {
			host: REDIS_HOST || "redis",
			port: Number(REDIS_PORT || 6379),
			password: REDIS_PASSWORD,
		},
	};

	const commonWorkerQueue = new Queue("common-worker", redisConnection);
	const commonWorkerEvents = new QueueEvents("common-worker", redisConnection);

	await commonWorkerEvents.waitUntilReady();
	await commonWorkerQueue.add("sync-providers", { userId, workspaceId });
};

const createUserWorkspace = async (userId: string, name?: string) => {
	const [workspace] = await db
		.insert(workspaces)
		.values({
			name: name ?? "Default Workspace",
			ownerId: userId,
			storageBytesUsed: 0,
		})
		.returning();

	return workspace;
};

const applyPendingMigrations = async (
	userId: string,
	workspaceId: string,
	email: string,
) => {
	const { migrationWorkerQueue } = await getRedis();

	await migrationWorkerQueue.add(
		"migration:run-for-user-after-signup",
		{ userId, workspaceId, email },
		{
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 3000,
			},
			removeOnComplete: { age: 60 },
			removeOnFail: false,
			jobId: `migration:${userId}:${APP_VERSION}`,
		},
	);
};

async function signToken(userId: string) {
	const { JWT_SECRET } = getServerEnv();

	return new SignJWT({})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(userId)
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(new TextEncoder().encode(JWT_SECRET));
}

async function setAuthToken(token: string) {
	const cookieStore = await cookies();

	cookieStore.set("session", token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
}

export async function createUserWithWorkspace(opts: {
	email: string;
	passwordHash: string;
	workspaceName?: string;
}) {
	const [existing] = await db
		.select()
		.from(users)
		.where(eq(users.email, opts.email));

	if (existing) {
		return { error: "An account with this email already exists" };
	}

	const [user] = await db
		.insert(users)
		.values({
			email: opts.email,
			passwordHash: opts.passwordHash,
		})
		.returning();

	const workspace = await createUserWorkspace(user.id, opts.workspaceName);

	await db
		.insert(workspaceMembers)
		.values({
			workspaceId: workspace.id,
			userId: user.id,
			role: "owner",
		})
		.onConflictDoNothing();

	await initProviders(user.id, workspace.id);
	await applyPendingMigrations(user.id, workspace.id, opts.email);

	return user;
}

export async function signInUserAndRedirect(user: typeof users.$inferSelect,  locale?: string) {
	await createSessionForUser(user.id);
	const target = await getWorkspaceRedirectUrl(user);
	// ss2i : connexion demandee par la page de consentement OAuth de l'MCP courrier
	// (/oauth/authorize a pose ce cookie) : on y retourne, le contexte du workspace
	// etant pose par getWorkspaceRedirectUrl. Chemin relatif ou origine MCP_PUBLIC_ORIGIN
	// seulement (isSafeOauthReturn), pas d'open redirect.
	const cookieStore = await cookies();
	const oauthReturn = cookieStore.get("oauth_return")?.value ?? "";
	if (oauthReturn && isSafeOauthReturn(oauthReturn)) {
		cookieStore.delete("oauth_return");
		redirect(oauthReturn);
	}
	redirect(target);
}

export async function createSessionForUser(userId: string) {
	const token = await signToken(userId);
	await setAuthToken(token);
}

export async function getWorkspaceRedirectUrl(user: typeof users.$inferSelect, locale?: string) {
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.ownerId, user.id));

	if (!workspace) {
		return "/auth/login";
	}

	await updateWorkSpaceContext(workspace.publicId, workspace.id, user);

	if (workspace.defaultIdentityId) {
		const [defaultIdentity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, workspace.defaultIdentityId));

		if (defaultIdentity) {
			if (locale) {
				redirect(withLocale(locale,`/w/${workspace.publicId}/dashboard/platform/overview`));
			}
			return `/w/${workspace.publicId}/dashboard/mail/${defaultIdentity.publicId}/inbox`;
		}
	}

	return `/w/${workspace.publicId}/dashboard/platform/overview`;
}

// Cookies du workspace actif. L'appelant fournit l'utilisateur deja authentifie et a
// verifie qu'il appartient a ce workspace (getWorkspaceRedirectUrl : son propre workspace ;
// switchWorkSpace : appartenance controlee).
export const updateWorkSpaceContext = async (workspacePublicId: string, id: string, user: Pick<UserEntity, "id">) => {
	const cookieStore = await cookies()
	let role: WorkspaceRolesListType = "member"
	const [member] = await db.select().from(workspaceMembers).where(and(
		eq(workspaceMembers.workspaceId, id),
		eq(workspaceMembers.userId, String(user?.id))
	)).limit(1)
	if (member){
		role = member.role as WorkspaceRolesListType
	}
	cookieStore.set({
		name: 'workspaceId',
		value: id,
		httpOnly: true,
		path: '/',
	})
	cookieStore.set({
		name: 'workspacePublicId',
		value: workspacePublicId,
		httpOnly: true,
		path: '/',
	})
	if (role){
		cookieStore.set({
			name: 'workspaceRole',
			value: String(role),
			httpOnly: true,
			path: '/',
		})
	}
};
