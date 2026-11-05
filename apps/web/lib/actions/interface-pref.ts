"use server";

import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { verifyAndDecode } from "@/lib/auth-session";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

// Mail interface, classic (default) or modern (three-column redesign, components/k).
// Per-user option, stored in workspaces.meta.prefInterface[<userId>], same principle as
// list-preview.ts: it follows the user from one device to another.

export type InterfaceMode = "classic" | "modern";

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

// Read on every render (root layout, mail layouts and pages): a single query. The user
// comes from the already signed session token (no re-read of the users table), membership
// of the workspace is checked in the same query. cache() avoids repeating it within a
// render.
export const interfaceMode = cache(async (): Promise<InterfaceMode> => {
	try {
		const jar = await cookies();
		const claims = await verifyAndDecode(jar.get("session")?.value);
		const userId = claims?.sub ? String(claims.sub) : null;
		const workspaceId = await getWorkspaceId();
		if (!userId || !workspaceId || workspaceId === "undefined") return "classic";
		const rows = await db.execute(sql`
			select w.meta->'prefInterface'->>${userId}::text as mode
			from workspaces w
			where w.id = ${workspaceId}::uuid
			  and exists (
				select 1 from workspace_members m
				where m.workspace_id = w.id and m.user_id = ${userId}::uuid
			  )
			limit 1
		`);
		const mode = (rows as any)?.rows?.[0]?.mode ?? (rows as any)?.[0]?.mode;
		return mode === "modern" ? "modern" : "classic";
	} catch {
		return "classic";
	}
});

export async function isModernUi() {
	return (await interfaceMode()) === "modern";
}

export async function setInterfaceMode(mode: InterfaceMode) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	const value: InterfaceMode = mode === "modern" ? "modern" : "classic";
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefInterface',
			coalesce(meta->'prefInterface', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	revalidatePath("/", "layout");
	return { success: true };
}
