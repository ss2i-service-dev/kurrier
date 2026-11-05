"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";

// Undo-send delay (seconds), per user, in workspaces.meta.prefUndoSend[<userId>] (same
// principle as rfc-style.ts). Read by sendMail when scheduling the job: 0 = send
// immediately, no undo. Sending by an AI agent (MCP, worker) keeps its own 30 s delay.

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
			.select({ s: sql<string | null>`${workspaces.metaData}->'prefUndoSend'->>${ctx.userId}::text` })
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
			set meta = meta #- array['prefUndoSend', ${ctx.userId}::text]
			where id = ${ctx.workspaceId}::uuid and meta ? 'prefUndoSend'
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
				'prefUndoSend',
				coalesce(meta->'prefUndoSend', '{}'::jsonb)
					|| jsonb_build_object(${ctx.userId}::text, ${n}::int)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	}
	return { success: true as const };
}
