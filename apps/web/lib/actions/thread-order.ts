"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Ordre des messages dans un fil ouvert : du plus ancien au plus recent
// (defaut, comportement d'origine, le dernier message en bas) ou du plus
// recent au plus ancien (le dernier message en haut). Option par utilisateur,
// rangee dans workspaces.meta.ss2iThreadOrder[<userId>] (meme principe que
// list-preview.ts) : elle suit l'utilisateur d'un poste a l'autre.

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
				>`${workspaces.metaData}->'ss2iThreadOrder'->>${ctx.userId}::text`,
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
		set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end) || jsonb_build_object(
			'ss2iThreadOrder',
			coalesce(meta->'ss2iThreadOrder', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// Les pages de fil lisent l'option : elles doivent etre reconstruites.
	revalidatePath("/", "layout");
	return { success: true };
}
