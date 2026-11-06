"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";
import { parseListUnderThread, type ListUnderThread } from "@/lib/list-under-thread";

// Interface classique : la liste du dossier reste-t-elle affichee sous un fil
// ouvert ? Masquee par defaut (le fil ouvert n'apparait plus deux fois), ou
// affichee (comportement d'origine). Option par utilisateur, rangee dans
// workspaces.meta.ss2iListUnderThread[<userId>] (meme principe que
// thread-order.ts) : elle suit l'utilisateur d'un poste a l'autre.

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
		if (!ctx) return "hidden";
		const [row] = await db
			.select({
				mode: sql<
					string | null
				>`${workspaces.metaData}->'ss2iListUnderThread'->>${ctx.userId}::text`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return parseListUnderThread(row?.mode);
	} catch {
		return "hidden";
	}
}

export async function setListUnderThread(mode: ListUnderThread) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	const value = parseListUnderThread(mode);
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'ss2iListUnderThread',
			coalesce(meta->'ss2iListUnderThread', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${value}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// La page du dossier lit l'option : elle doit etre reconstruite.
	revalidatePath("/", "layout");
	return { success: true };
}
