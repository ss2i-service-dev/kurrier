"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";

// ss2i : boites repliees dans la barre laterale du courrier (seul le nom et le nombre de
// non lus de l'Inbox restent visibles). Preference par utilisateur, rangee dans
// workspaces.meta.ss2iCollapsedIdentities[<userId>] = [publicId d'identite, ...] (meme
// principe que rfc-style.ts), donc la meme sur tous les postes de l'utilisateur.

async function context() {
	const user = await isSignedIn();
	if (!user) return null;
	const workspaceId = await getWorkspaceId();
	if (!workspaceId || workspaceId === "undefined") return null;
	const [member] = await db
		.select({ id: workspaceMembers.id })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.userId, user.id),
			),
		)
		.limit(1);
	if (!member) return null;
	return { userId: String(user.id), workspaceId };
}

export async function collapsedIdentities(): Promise<string[]> {
	try {
		const ctx = await context();
		if (!ctx) return [];
		const [row] = await db
			.select({
				ids: sql<unknown>`${workspaces.metaData}->'ss2iCollapsedIdentities'->${ctx.userId}::text`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return Array.isArray(row?.ids)
			? (row!.ids as unknown[]).filter((v): v is string => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

export async function setIdentityCollapsed(identityPublicId: string, collapsed: boolean) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	if (typeof identityPublicId !== "string" || !identityPublicId || identityPublicId.length > 64) {
		return { success: false, error: "Invalid identity" };
	}
	const current = await collapsedIdentities();
	const next = collapsed
		? Array.from(new Set([...current, identityPublicId]))
		: current.filter((id) => id !== identityPublicId);
	await db.execute(sql`
		update workspaces
		set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end) || jsonb_build_object(
			'ss2iCollapsedIdentities',
			coalesce(meta->'ss2iCollapsedIdentities', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${JSON.stringify(next)}::jsonb)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	return { success: true };
}
