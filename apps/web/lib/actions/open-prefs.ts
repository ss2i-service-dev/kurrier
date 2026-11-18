"use server";
// SS2i : ouverture des fils (onglets internes), par utilisateur, dans
// workspaces.meta.ss2iOpenPrefs[<userId>] = { tabs, gesture }. Meme principe que
// les raccourcis clavier (shortcuts.ts) : le reglage suit l'utilisateur d'un
// poste a l'autre. Valeur par defaut (onglets desactives) : aucune entree.
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { verifyAndDecode } from "@/lib/auth-session";
import { DEFAULT_OPEN_PREFS, sanitizeOpenPrefs, type OpenPrefs } from "@/components/k/open-prefs";

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

async function isMember(ctx: { userId: string; workspaceId: string }) {
	const res = await db.execute(sql`
		select 1 as ok from workspace_members
		where workspace_id = ${ctx.workspaceId}::uuid and user_id = ${ctx.userId}::uuid
		limit 1
	`);
	return !!rowsOf(res)[0];
}

export async function fetchOpenPrefs(): Promise<OpenPrefs> {
	try {
		const ctx = await who();
		if (!ctx || !(await isMember(ctx))) return DEFAULT_OPEN_PREFS;
		const res = await db.execute(sql`
			select w.meta->'ss2iOpenPrefs'->${ctx.userId}::text as prefs
			from workspaces w
			where w.id = ${ctx.workspaceId}::uuid
			limit 1
		`);
		return sanitizeOpenPrefs(rowsOf(res)[0]?.prefs);
	} catch {
		return DEFAULT_OPEN_PREFS;
	}
}

export async function saveOpenPrefs(raw: unknown) {
	const ctx = await who();
	if (!ctx || !(await isMember(ctx))) return { success: false as const, error: "Non connecté" };
	const prefs = sanitizeOpenPrefs(raw);
	const isDefault = prefs.tabs === DEFAULT_OPEN_PREFS.tabs && prefs.gesture === DEFAULT_OPEN_PREFS.gesture;
	if (isDefault) {
		await db.execute(sql`
			update workspaces
			set meta = meta #- array['ss2iOpenPrefs', ${ctx.userId}::text]
			where id = ${ctx.workspaceId}::uuid and jsonb_typeof(meta) = 'object' and meta ? 'ss2iOpenPrefs'
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end) || jsonb_build_object(
				'ss2iOpenPrefs',
				(case when jsonb_typeof(meta->'ss2iOpenPrefs') = 'object' then meta->'ss2iOpenPrefs' else '{}'::jsonb end)
					|| jsonb_build_object(${ctx.userId}::text, ${JSON.stringify(prefs)}::jsonb)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	}
	return { success: true as const, prefs };
}
