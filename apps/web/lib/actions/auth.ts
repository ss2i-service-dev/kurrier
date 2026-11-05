"use server";

import { db, users } from "@db";
import { FormState, getPublicEnv } from "@schema";
import argon2 from "argon2";
import { decode } from "decode-formdata";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import * as crypto from "node:crypto";
// ss2i (controle d'acces) : creation de compte, ouverture de session et redirection vers le
// workspace vivent dans un module serveur qui n'est pas un module d'actions.
import { createUserWithWorkspace, signInUserAndRedirect, verifyAndDecode } from "@/lib/auth-session";
import { consumePendingCeriseLink } from "@/lib/cerise-account";
import { CERISE_LINK_COOKIE, CERISE_LINK_FIELD } from "@common/cerise-auth";


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

	// ss2i (OI 10297) : premier passage par Cerise sur une adresse de ce compte (cookie
	// cerise_link) : le mot de passe vient d'être vérifié ; le lien se pose seulement si la
	// case « lier Cerise » est cochée et que le compte a cette adresse. Le cookie est effacé
	// dans tous les cas.
	await consumePendingCeriseLink(user.id, formData.get(CERISE_LINK_FIELD) === "1");

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
	cookieStore.delete(CERISE_LINK_COOKIE);
	redirect(redirectUrl ? redirectUrl : "/auth/login");
};

export const getGravatarUrl = async (email: string, size = 80) => {
	const trimmedEmail = email.trim().toLowerCase();
	const hash = crypto.createHash("sha256").update(trimmedEmail).digest("hex");
	return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
};
