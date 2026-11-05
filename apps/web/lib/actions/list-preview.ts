"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Content of the rows of the thread list: subject only, or subject followed by the
// snippet (default, original behaviour). Per-user option, stored in
// workspaces.meta.prefListPreview[<userId>] (same principle as unread-panel.ts): it
// follows the user from one device to another.

export type ListPreviewMode = "subject" | "subject_snippet";

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

export async function listPreviewMode(): Promise<ListPreviewMode> {
	try {
		const ctx = await context();
		if (!ctx) return "subject_snippet";
		const [row] = await db
			.select({
				mode: sql<
					string | null
				>`${workspaces.metaData}->'prefListPreview'->>${ctx.userId}::text`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return row?.mode === "subject" ? "subject" : "subject_snippet";
	} catch {
		return "subject_snippet";
	}
}

export async function setListPreviewMode(mode: ListPreviewMode) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	const value: ListPreviewMode =
		mode === "subject" ? "subject" : "subject_snippet";
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefListPreview',
			coalesce(meta->'prefListPreview', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The mail layout reads the option: it must be rebuilt.
	revalidatePath("/", "layout");
	return { success: true };
}
