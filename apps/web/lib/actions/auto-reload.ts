"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Reload the page after an update (components/common/version-watcher.tsx). Per-user option, off
// by default, stored in workspaces.meta.prefAutoReloadOnUpdate[<userId>] (same principle as
// hour-format.ts): it follows the user from one device to another.

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

export async function autoReloadEnabled() {
	try {
		const ctx = await context();
		if (!ctx) return false;
		const [row] = await db
			.select({
				on: sql<boolean>`coalesce((${workspaces.metaData}->'prefAutoReloadOnUpdate'->>${ctx.userId}::text)::boolean, false)`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return Boolean(row?.on);
	} catch {
		return false;
	}
}

export async function setAutoReloadEnabled(enabled: boolean) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	await db.execute(sql`
		update workspaces
		set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end) || jsonb_build_object(
			'prefAutoReloadOnUpdate',
			coalesce(meta->'prefAutoReloadOnUpdate', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${Boolean(enabled)}::boolean)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The root layout mounts the watcher according to the option.
	revalidatePath("/", "layout");
	return { success: true };
}
