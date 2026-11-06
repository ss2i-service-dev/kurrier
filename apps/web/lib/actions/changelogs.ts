"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { compareVersions, type ChangelogEntry } from "@/lib/changelogs";
import { listChangelogs } from "@/lib/changelogs-files";

// ss2i (OI 10363) : modale « Nouveautes ». Derniere note vue par utilisateur, cote
// serveur, pour qu'une note lue sur un poste ne se rouvre ni apres F5 ni sur un autre
// poste. Rangee dans workspaces.meta.ss2iChangelogSeen[<userId>], meme principe que
// interface-pref.ts et list-preview.ts : aucune table, aucune migration.

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

async function readLastSeen(ctx: { userId: string; workspaceId: string }): Promise<string | null> {
	const [row] = await db
		.select({ seen: sql<string | null>`${workspaces.metaData}->'ss2iChangelogSeen'->>${ctx.userId}::text` })
		.from(workspaces)
		.where(eq(workspaces.id, ctx.workspaceId))
		.limit(1);
	return row?.seen ?? null;
}

/** Notes de version (la plus recente d'abord) et derniere version vue par l'appelant. */
export async function fetchChangelogs(): Promise<{ entries: ChangelogEntry[]; lastSeen: string | null }> {
	try {
		const entries = listChangelogs();
		if (!entries.length) return { entries: [], lastSeen: null };
		const ctx = await context();
		if (!ctx) return { entries: [], lastSeen: null };
		return { entries, lastSeen: await readLastSeen(ctx) };
	} catch (e) {
		// Les nouveautes ne doivent jamais empecher d'afficher la messagerie.
		console.error("[changelogs] lecture impossible", e);
		return { entries: [], lastSeen: null };
	}
}

/**
 * Marque les nouveautes comme vues jusqu'a `version`. On ne recule jamais : rouvrir une
 * ancienne note ne fait pas reapparaitre les suivantes. Seule une version qui existe est
 * acceptee.
 */
export async function markChangelogSeen(version: string): Promise<{ success: boolean; lastSeen?: string | null }> {
	const ctx = await context();
	if (!ctx) return { success: false };
	if (!listChangelogs().some((e) => e.version === version)) return { success: false };
	const current = await readLastSeen(ctx);
	if (current && compareVersions(version, current) <= 0) return { success: true, lastSeen: current };
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'ss2iChangelogSeen',
			coalesce(meta->'ss2iChangelogSeen', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${version}::text)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	return { success: true, lastSeen: version };
}
