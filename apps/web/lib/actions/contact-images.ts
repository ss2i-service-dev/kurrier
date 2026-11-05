"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";

// "Load remote images" preference per sender. Stored in
// workspaces.meta.prefRemoteImages[<userId>] (list of addresses), and NOT on a
// contact: the address book only receives people we wrote to, a sender whose
// images we accept does not belong there. Valid on all of the user's browsers.
// Export names kept for the callers.

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

function normalize(email: string | null | undefined) {
	const addr = String(email ?? "").trim().toLowerCase();
	return addr.includes("@") ? addr : null;
}

export async function remoteImagesAllowedForContact(email: string | null | undefined) {
	const addr = normalize(email);
	if (!addr) return false;
	try {
		const ctx = await context();
		if (!ctx) return false;
		const [row] = await db
			.select({
				ok: sql<boolean>`coalesce(${workspaces.metaData}->'prefRemoteImages'->${ctx.userId}::text ? ${addr}, false)`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return Boolean(row?.ok);
	} catch {
		return false;
	}
}

export async function setRemoteImagesForContact(input: {
	email: string;
	name?: string | null;
	allow: boolean;
}) {
	const addr = normalize(input.email);
	if (!addr) return { success: false, error: "Invalid address" };
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };

	// Atomic update of the user's list, without duplicates.
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefRemoteImages',
			coalesce(meta->'prefRemoteImages', '{}'::jsonb) || jsonb_build_object(
				${ctx.userId}::text,
				(
					select coalesce(jsonb_agg(distinct v), '[]'::jsonb)
					from jsonb_array_elements_text(
						coalesce(meta->'prefRemoteImages'->${ctx.userId}::text, '[]'::jsonb)
						|| case when ${input.allow}::boolean then jsonb_build_array(${addr}::text) else '[]'::jsonb end
					) v
					where ${input.allow}::boolean or v <> ${addr}::text
				)
			)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	return { success: true, created: false };
}
