"use server";

import { db, users } from "@db";
import { FormState, getPublicEnv } from "@schema";
import argon2 from "argon2";
import { decode } from "decode-formdata";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import * as crypto from "node:crypto";
// Account creation, sign-in and the redirect to the workspace live in a server module
// that is not a "use server" actions module.
import { createUserWithWorkspace, signInUserAndRedirect, verifyAndDecode } from "@/lib/auth-session";


export async function login(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const { email, password, locale } = decode(formData) as {
		email: string;
		password: string;
		locale?: string;
	};

	if (!email || !password) {
		return { error: "Missing email or password" };
	}

	const [user] = await db.select().from(users).where(eq(users.email, email));

	if (!user || !user.passwordHash) {
		return { error: "Invalid credentials" };
	}

	const valid = await argon2.verify(user.passwordHash, password);

	if (!valid) {
		return { error: "Invalid credentials" };
	}

	await signInUserAndRedirect(user, locale);

	return { success: true, message: "Logged in!" };
}

export async function signup(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const { DISABLE_SIGNUP } = getPublicEnv();

	if (DISABLE_SIGNUP) {
		return {
			success: false,
			error: "Signup is currently disabled. Please contact your administrator.",
		};
	}

	const { workspaceName, email, password } = decode(formData) as {
		email: string;
		password: string;
		workspaceName: string;
	};

	if (!email || !password) {
		return { error: "Missing email or password" };
	}

	const passwordHash = await argon2.hash(password);

	const user = await createUserWithWorkspace({
		email,
		passwordHash,
		workspaceName,
	});

	if ("error" in user) {
		return { error: user.error };
	}

	await signInUserAndRedirect(user);

	return { success: true, message: "Welcome!" };
}

export async function isSignedIn() {
	const cookieStore = await cookies();
	const token = cookieStore.get("session")?.value;

	if (!token) {
		return null;
	}

	const claims = await verifyAndDecode(token);

	if (!claims?.sub) {
		return null;
	}

	const [user] = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(eq(users.id, claims.sub));

	if (!user) {
		return null;
	}

	return user;
}

export type FetchIsSignedInResult = Awaited<ReturnType<typeof isSignedIn>>;

export const signOut = async (redirectUrl?: string) => {
	const cookieStore = await cookies();
	cookieStore.delete("session");
	redirect(redirectUrl ? redirectUrl : "/auth/login");
};

export const getGravatarUrl = async (email: string, size = 80) => {
	const trimmedEmail = email.trim().toLowerCase();
	const hash = crypto.createHash("sha256").update(trimmedEmail).digest("hex");
	return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
};
