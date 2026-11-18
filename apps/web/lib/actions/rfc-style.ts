"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Style RFC a l'envoi : reponse sous la citation et signature tout en bas, precedee de
// la ligne « -- » (RFC 3676 §4.3). Option par utilisateur, desactivee par defaut, rangee
// dans workspaces.meta.ss2iRfcStyle[<userId>] (meme principe que unread-panel.ts). Le
// worker la lit au moment d'assembler le message (send-mail.ts, rfcStyleEnabled).

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
				on: sql<boolean>`coalesce((${workspaces.metaData}->'ss2iRfcStyle'->>${ctx.userId}::text)::boolean, false)`,
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
		set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end) || jsonb_build_object(
			'ss2iRfcStyle',
			coalesce(meta->'ss2iRfcStyle', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${Boolean(enabled)}::boolean)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// Le layout du courrier lit l'option (apercu de la citation dans l'editeur).
	revalidatePath("/", "layout");
	return { success: true };
}
