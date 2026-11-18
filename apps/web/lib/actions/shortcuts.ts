"use server";
// SS2i : raccourcis clavier personnalises, par utilisateur, dans
// workspaces.meta.ss2iShortcuts[<userId>] = { enabled, keys } (seulement les
// ecarts aux valeurs par defaut, components/k/shortcuts-catalog.ts). Meme
// principe que thread-order.ts : ils suivent l'utilisateur d'un poste a l'autre.
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
			select w.meta->'ss2iShortcuts'->${ctx.userId}::text as prefs
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
	if (!ctx) return { success: false as const, error: "Non connecté" };
	const member = rowsOf(
		await db.execute(sql`
			select 1 as ok from workspace_members
			where workspace_id = ${ctx.workspaceId}::uuid and user_id = ${ctx.userId}::uuid
			limit 1
		`),
	)[0];
	if (!member) return { success: false as const, error: "Non connecté" };
	const prefs = compactPrefs(sanitizePrefs(raw));
	const isDefault = prefs.enabled && Object.keys(prefs.keys).length === 0;
	if (isDefault) {
		await db.execute(sql`
			update workspaces
			set meta = meta #- array['ss2iShortcuts', ${ctx.userId}::text]
			where id = ${ctx.workspaceId}::uuid and meta ? 'ss2iShortcuts'
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end) || jsonb_build_object(
				'ss2iShortcuts',
				coalesce(meta->'ss2iShortcuts', '{}'::jsonb)
					|| jsonb_build_object(${ctx.userId}::text, ${JSON.stringify(prefs)}::jsonb)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	}
	return { success: true as const, prefs };
}
