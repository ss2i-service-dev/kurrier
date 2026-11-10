"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Subject without "Re:", "Fwd:" and the prefixes stacked by other clients (packages/common/src/
// subject.ts). Per-user option, disabled by default, stored in
// workspaces.meta.prefStripSubjectPrefixes[<userId>] (same principle as rfc-style.ts). The
// worker reads it when assembling the message (send-mail.ts, stripSubjectPrefixesEnabled).

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

export async function stripSubjectPrefixesEnabled() {
	try {
		const ctx = await context();
		if (!ctx) return false;
		const [row] = await db
			.select({
				on: sql<boolean>`coalesce((${workspaces.metaData}->'prefStripSubjectPrefixes'->>${ctx.userId}::text)::boolean, false)`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return Boolean(row?.on);
	} catch {
		return false;
	}
}

export async function setStripSubjectPrefixesEnabled(enabled: boolean) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefStripSubjectPrefixes',
			coalesce(meta->'prefStripSubjectPrefixes', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${Boolean(enabled)}::boolean)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The mail layout reads the option (lists, threads and editor).
	revalidatePath("/", "layout");
	return { success: true };
}
