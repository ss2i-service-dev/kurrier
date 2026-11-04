"use server";
// SS2i (Outlook) : fils epingles, propres a chaque utilisateur. Un fil epingle
// reste en tete de son dossier. Stockage dans workspaces.meta.ss2iPinned
// [userId][threadId] = date d'epinglage (meme principe que les preferences
// d'affichage des collegues : pas de migration de schema).
import { cache } from "react";
import { cookies } from "next/headers";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, mailboxThreads } from "@db";
import { getWorkspaceId, rlsClient } from "@/lib/actions/clients";
import { verifyAndDecode } from "@/lib/auth-session";
import { fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { kRealAttachmentsOf } from "@/lib/actions/k-threads";

const MAX_PINS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** threadId -> date d'epinglage, pour l'utilisateur courant. */
export const kPinnedMap = cache(async (): Promise<Record<string, string>> => {
	try {
		const ctx = await who();
		if (!ctx) return {};
		const res = await db.execute(sql`
			select w.meta->'ss2iPinned'->${ctx.userId}::text as pins
			from workspaces w
			where w.id = ${ctx.workspaceId}::uuid
			  and exists (
				select 1 from workspace_members m
				where m.workspace_id = w.id and m.user_id = ${ctx.userId}::uuid
			  )
			limit 1
		`);
		const pins = rowsOf(res)[0]?.pins;
		return pins && typeof pins === "object" ? (pins as Record<string, string>) : {};
	} catch {
		return {};
	}
});

export async function setThreadPinned(threadId: string, pinned: boolean) {
	if (!UUID.test(String(threadId))) return { success: false, error: "Fil inconnu" };
	const ctx = await who();
	if (!ctx) return { success: false, error: "Non connecté" };
	const member = rowsOf(
		await db.execute(sql`
			select 1 as ok from workspace_members
			where workspace_id = ${ctx.workspaceId}::uuid and user_id = ${ctx.userId}::uuid
			limit 1
		`),
	)[0];
	if (!member) return { success: false, error: "Non connecté" };

	if (pinned) {
		const current = await kPinnedMap();
		if (!current[threadId] && Object.keys(current).length >= MAX_PINS) {
			return { success: false, error: `${MAX_PINS} fils épinglés au maximum` };
		}
		await db.execute(sql`
			update workspaces
			set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
				'ss2iPinned',
				coalesce(meta->'ss2iPinned', '{}'::jsonb) || jsonb_build_object(
					${ctx.userId}::text,
					coalesce(meta->'ss2iPinned'->${ctx.userId}::text, '{}'::jsonb)
						|| jsonb_build_object(${threadId}::text, ${new Date().toISOString()}::text)
				)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = meta #- array['ss2iPinned', ${ctx.userId}::text, ${threadId}::text]
			where id = ${ctx.workspaceId}::uuid and meta ? 'ss2iPinned'
		`);
	}
	return { success: true };
}

/** Fils epingles presents dans ce dossier (memes regles que la liste : RLS, reports). */
export async function fetchKPinnedThreads(identityPublicId: string, mailboxSlug: string) {
	const pins = await kPinnedMap();
	const ids = Object.keys(pins).filter((id) => UUID.test(id));
	if (!ids.length) return { pinnedIds: [] as string[], mailboxThreads: [] as any[], labelsByThreadId: {} as Record<string, any[]>, realAttachments: [] as string[] };
	const rls = await rlsClient();
	const now = new Date();
	const rows = await rls((tx) =>
		tx
			.select({ thread: mailboxThreads })
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.identityPublicId, identityPublicId),
					eq(mailboxThreads.mailboxSlug, mailboxSlug),
					inArray(mailboxThreads.threadId, ids),
					or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
				),
			)
			.orderBy(desc(mailboxThreads.lastActivityAt))
			.limit(MAX_PINS),
	);
	const threads = rows.map((r) => r.thread);
	const [labelsByThreadId, realAttachments] = threads.length
		? await Promise.all([fetchMailboxThreadLabels(threads as any), kRealAttachmentsOf(threads as any)])
		: [{}, [] as string[]];
	return { pinnedIds: ids, mailboxThreads: threads, labelsByThreadId, realAttachments };
}
