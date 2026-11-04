"use server";

import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { verifyAndDecode } from "@/lib/auth-session";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

// ss2i : interface de la messagerie, classique (defaut, celle de tout le monde)
// ou nouvelle (refonte en trois colonnes, components/k). Option par utilisateur,
// rangee dans workspaces.meta.ss2iInterface[<userId>], meme principe que
// list-preview.ts : elle suit l'utilisateur d'un poste a l'autre.

export type InterfaceMode = "classic" | "nouvelle";

async function context() {
	const user = await isSignedIn();
	if (!user) return null;
	const workspaceId = await getWorkspaceId();
	if (!workspaceId || workspaceId === "undefined") return null;
	const [member] = await db
		.select({ id: workspaceMembers.id })
		.from(workspaceMembers)
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)))
		.limit(1);
	if (!member) return null;
	return { userId: String(user.id), workspaceId };
}

// Lu a chaque rendu (layout racine, layouts et pages de la messagerie) : une
// seule requete. L'utilisateur vient du jeton de session deja signe (pas de
// relecture de la table users), l'appartenance a l'espace de travail est
// verifiee dans la meme requete. cache() evite de la repeter dans un rendu.
// Avant : trois requetes (users, workspace_members, workspaces) a chaque appel.
export const interfaceMode = cache(async (): Promise<InterfaceMode> => {
	try {
		const jar = await cookies();
		const claims = await verifyAndDecode(jar.get("session")?.value);
		const userId = claims?.sub ? String(claims.sub) : null;
		const workspaceId = await getWorkspaceId();
		if (!userId || !workspaceId || workspaceId === "undefined") return "classic";
		const rows = await db.execute(sql`
			select w.meta->'ss2iInterface'->>${userId}::text as mode
			from workspaces w
			where w.id = ${workspaceId}::uuid
			  and exists (
				select 1 from workspace_members m
				where m.workspace_id = w.id and m.user_id = ${userId}::uuid
			  )
			limit 1
		`);
		const mode = (rows as any)?.rows?.[0]?.mode ?? (rows as any)?.[0]?.mode;
		return mode === "nouvelle" ? "nouvelle" : "classic";
	} catch {
		return "classic";
	}
});

export async function isNouvelleInterface() {
	return (await interfaceMode()) === "nouvelle";
}

export async function setInterfaceMode(mode: InterfaceMode) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	const value: InterfaceMode = mode === "nouvelle" ? "nouvelle" : "classic";
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'ss2iInterface',
			coalesce(meta->'ss2iInterface', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	revalidatePath("/", "layout");
	return { success: true };
}
