"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";
import { parseListUnderThread, type ListUnderThread } from "@/lib/list-under-thread";

// Classic interface: does the folder list stay displayed under an open thread? Shown
// (default, original behaviour) or hidden (an open thread is no longer followed by the list
// that repeats it). Per-user option, stored in workspaces.meta.prefListUnderThread[<userId>]
// (same principle as thread-order.ts): it follows the user from one device to another.

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

export async function listUnderThread(): Promise<ListUnderThread> {
	try {
		const ctx = await context();
		if (!ctx) return "shown";
		const [row] = await db
			.select({
				mode: sql<
					string | null
				>`${workspaces.metaData}->'prefListUnderThread'->>${ctx.userId}::text`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return parseListUnderThread(row?.mode);
	} catch {
		return "shown";
	}
}

export async function setListUnderThread(mode: ListUnderThread) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	const value = parseListUnderThread(mode);
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefListUnderThread',
			coalesce(meta->'prefListUnderThread', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The folder page reads the option: it must be rebuilt.
	revalidatePath("/", "layout");
	return { success: true };
}
