"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";

// Delai d'annulation de l'envoi (secondes), par utilisateur, dans
// workspaces.meta.ss2iUndoSend[<userId>] (meme principe que rfc-style.ts). Lu par
// sendMail au moment de programmer le job : 0 = envoi immediat, sans annulation.
// L'envoi par un agent IA (MCP, worker) garde son propre delai de 30 s.

const CHOICES = [0, 5, 10, 20, 30, 60];
const DEFAULT_SECONDS = 30;

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

export async function undoSendSeconds(): Promise<number> {
	try {
		const ctx = await context();
		if (!ctx) return DEFAULT_SECONDS;
		const [row] = await db
			.select({ s: sql<string | null>`${workspaces.metaData}->'ss2iUndoSend'->>${ctx.userId}::text` })
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		const n = Number(row?.s);
		return row?.s != null && CHOICES.includes(n) ? n : DEFAULT_SECONDS;
	} catch {
		return DEFAULT_SECONDS;
	}
}

export async function setUndoSendSeconds(seconds: number) {
	const ctx = await context();
	if (!ctx) return { success: false as const, error: "Not authenticated" };
	const n = Number(seconds);
	if (!CHOICES.includes(n)) return { success: false as const, error: "Invalid value" };
	if (n === DEFAULT_SECONDS) {
		await db.execute(sql`
			update workspaces
			set meta = meta #- array['ss2iUndoSend', ${ctx.userId}::text]
			where id = ${ctx.workspaceId}::uuid and meta ? 'ss2iUndoSend'
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
				'ss2iUndoSend',
				coalesce(meta->'ss2iUndoSend', '{}'::jsonb)
					|| jsonb_build_object(${ctx.userId}::text, ${n}::int)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	}
	return { success: true as const };
}
