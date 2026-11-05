"use server";
// Custom keyboard shortcuts, per user, in
// workspaces.meta.prefShortcuts[<userId>] = { enabled, keys } (only the differences from
// the defaults, components/k/shortcuts-catalog.ts). Same principle as thread-order.ts:
// they follow the user from one device to another.
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { verifyAndDecode } from "@/lib/auth-session";
import { compactPrefs, DEFAULT_PREFS, sanitizePrefs, type ShortcutPrefs } from "@/components/k/shortcuts-catalog";

async function who() {
	const jar = await cookies();
	const claims = await verifyAndDecode(jar.get("session")?.value);
	const userId = claims?.sub ? String(claims.sub) : null;
	const workspaceId = await getWorkspaceId();
	if (!userId || !workspaceId || workspaceId === "undefined") return null;
	return { userId, workspaceId };
}

function rowsOf(res: unknown): any[] {
	return ((res as any)?.rows ?? res ?? []) as any[];
}

export async function fetchShortcutPrefs(): Promise<ShortcutPrefs> {
	try {
		const ctx = await who();
		if (!ctx) return DEFAULT_PREFS;
		const res = await db.execute(sql`
			select w.meta->'prefShortcuts'->${ctx.userId}::text as prefs
			from workspaces w
			where w.id = ${ctx.workspaceId}::uuid
			  and exists (
				select 1 from workspace_members m
				where m.workspace_id = w.id and m.user_id = ${ctx.userId}::uuid
			  )
			limit 1
		`);
		return sanitizePrefs(rowsOf(res)[0]?.prefs);
	} catch {
		return DEFAULT_PREFS;
	}
}

export async function saveShortcutPrefs(raw: unknown) {
	const ctx = await who();
	if (!ctx) return { success: false as const, error: "Not signed in" };
	const member = rowsOf(
		await db.execute(sql`
			select 1 as ok from workspace_members
			where workspace_id = ${ctx.workspaceId}::uuid and user_id = ${ctx.userId}::uuid
			limit 1
		`),
	)[0];
	if (!member) return { success: false as const, error: "Not signed in" };
	const prefs = compactPrefs(sanitizePrefs(raw));
	const isDefault = prefs.enabled && Object.keys(prefs.keys).length === 0;
	if (isDefault) {
		await db.execute(sql`
			update workspaces
			set meta = meta #- array['prefShortcuts', ${ctx.userId}::text]
			where id = ${ctx.workspaceId}::uuid and meta ? 'prefShortcuts'
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
				'prefShortcuts',
				coalesce(meta->'prefShortcuts', '{}'::jsonb)
					|| jsonb_build_object(${ctx.userId}::text, ${JSON.stringify(prefs)}::jsonb)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	}
	return { success: true as const, prefs };
}
