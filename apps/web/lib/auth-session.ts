import "server-only";

// Account creation, sign-in and workspace context. These functions used to be exported by
// lib/actions/auth.ts and workspace.ts, "use server" files: each one was therefore an
// action callable by anyone (createSessionForUser(userId) opened a session for any user,
// createUserWithWorkspace bypassed DISABLE_SIGNUP, updateWorkSpaceContext set the cookies
// of any workspace). This module is not an actions module: only the server (login, signup,
// OIDC, session resume, workspace switch) calls them.
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
import { jwtVerify, JWTPayload, SignJWT } from "jose";
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
	// Sign-in requested by the OAuth consent page of the MCP endpoint (/oauth/authorize set
	// this cookie): go back there, the workspace context being set by
	// getWorkspaceRedirectUrl. Relative path or MCP_PUBLIC_ORIGIN origin only
	// (isSafeOauthReturn), no open redirect.
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

// Cookies of the active workspace. The caller supplies the already authenticated user and
// has verified that they belong to this workspace (getWorkspaceRedirectUrl: their own
// workspace; switchWorkSpace: membership checked).
// The workspace cookies used to be session cookies (no lifetime) while the "session"
// cookie lives 30 days. When the browser was closed they disappeared, the session stayed
// valid and every page failed with "No workspace selected", reload included. Same lifetime
// as the session; the proxy sets them again anyway if the URL carries another workspace.
const WORKSPACE_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: process.env.NODE_ENV === "production",
	sameSite: "lax" as const,
	path: "/",
	maxAge: 60 * 60 * 24 * 30,
};

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
		...WORKSPACE_COOKIE_OPTIONS,
	})
	cookieStore.set({
		name: 'workspacePublicId',
		value: workspacePublicId,
		...WORKSPACE_COOKIE_OPTIONS,
	})
	if (role){
		cookieStore.set({
			name: 'workspaceRole',
			value: String(role),
			...WORKSPACE_COOKIE_OPTIONS,
		})
	}
};

// Moved out of lib/actions/auth.ts. As an action, currentSession returned to the browser
// the session token that the httpOnly cookie was meant to hide from it.
export type TokenClaims = JWTPayload & {
	sub: string;
	workspace_id?: string;
};

export async function verifyAndDecode(
	token?: string,
): Promise<TokenClaims | null> {
	if (!token) return null;

	try {
		const { JWT_SECRET } = getServerEnv();
		const { payload } = await jwtVerify<TokenClaims>(
			token,
			new TextEncoder().encode(JWT_SECRET),
		);

		if (!payload.sub) {
			return null;
		}
		// A session token never carries an audience: any other JWT signed with
		// JWT_SECRET is not a session.
		if (payload.aud !== undefined) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}

export const currentSession = async () => {
	const cookieStore = await cookies();
	return String(cookieStore.get("session")?.value);
};
