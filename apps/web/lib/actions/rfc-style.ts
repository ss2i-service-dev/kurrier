"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// RFC style on send: reply below the quote and signature at the very bottom, preceded by
// the "-- " line (RFC 3676 section 4.3). Per-user option, disabled by default, stored in
// workspaces.meta.prefRfcStyle[<userId>] (same principle as unread-panel.ts). The worker
// reads it when assembling the message (send-mail.ts, rfcStyleEnabled).

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

export async function rfcStyleEnabled() {
	try {
		const ctx = await context();
		if (!ctx) return false;
		const [row] = await db
			.select({
				on: sql<boolean>`coalesce((${workspaces.metaData}->'prefRfcStyle'->>${ctx.userId}::text)::boolean, false)`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return Boolean(row?.on);
	} catch {
		return false;
	}
}

export async function setRfcStyleEnabled(enabled: boolean) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefRfcStyle',
			coalesce(meta->'prefRfcStyle', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${Boolean(enabled)}::boolean)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The mail layout reads the option (quote preview in the editor).
	revalidatePath("/", "layout");
	return { success: true };
}
