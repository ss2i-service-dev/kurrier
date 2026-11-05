"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Order of the messages in an open thread: oldest to newest (default, original
// behaviour, latest message at the bottom) or newest to oldest (latest message at the
// top). Per-user option, stored in workspaces.meta.prefThreadOrder[<userId>] (same
// principle as list-preview.ts): it follows the user from one device to another.

export type ThreadOrder = "oldest_first" | "newest_first";

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

export async function threadOrder(): Promise<ThreadOrder> {
	try {
		const ctx = await context();
		if (!ctx) return "oldest_first";
		const [row] = await db
			.select({
				order: sql<
					string | null
				>`${workspaces.metaData}->'prefThreadOrder'->>${ctx.userId}::text`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return row?.order === "newest_first" ? "newest_first" : "oldest_first";
	} catch {
		return "oldest_first";
	}
}

export async function setThreadOrder(order: ThreadOrder) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	const value: ThreadOrder =
		order === "newest_first" ? "newest_first" : "oldest_first";
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefThreadOrder',
			coalesce(meta->'prefThreadOrder', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The thread pages read the option: they must be rebuilt.
	revalidatePath("/", "layout");
	return { success: true };
}
