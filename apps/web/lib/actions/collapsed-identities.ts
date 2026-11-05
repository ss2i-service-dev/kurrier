"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";

// Identities collapsed in the mail sidebar (only the name and the Inbox unread count stay
// visible). Per-user preference, stored in
// workspaces.meta.prefCollapsedIdentities[<userId>] = [identity publicId, ...] (same
// principle as rfc-style.ts), hence the same on all of the user's devices.

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
				ids: sql<unknown>`${workspaces.metaData}->'prefCollapsedIdentities'->${ctx.userId}::text`,
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
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefCollapsedIdentities',
			coalesce(meta->'prefCollapsedIdentities', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${JSON.stringify(next)}::jsonb)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	return { success: true };
}
