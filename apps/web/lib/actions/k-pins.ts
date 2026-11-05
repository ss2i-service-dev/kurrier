"use server";
// Pinned threads, per user. A pinned thread stays at the top of its mailbox. Stored in
// workspaces.meta.prefPinned[userId][threadId] = pin date (same principle as the display
// preferences: no schema migration).
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

/** threadId -> pin date, for the current user. */
export const kPinnedMap = cache(async (): Promise<Record<string, string>> => {
	try {
		const ctx = await who();
		if (!ctx) return {};
		const res = await db.execute(sql`
			select w.meta->'prefPinned'->${ctx.userId}::text as pins
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
	if (!UUID.test(String(threadId))) return { success: false, error: "Unknown thread" };
	const ctx = await who();
	if (!ctx) return { success: false, error: "Not signed in" };
	const member = rowsOf(
		await db.execute(sql`
			select 1 as ok from workspace_members
			where workspace_id = ${ctx.workspaceId}::uuid and user_id = ${ctx.userId}::uuid
			limit 1
		`),
	)[0];
	if (!member) return { success: false, error: "Not signed in" };

	if (pinned) {
		const current = await kPinnedMap();
		if (!current[threadId] && Object.keys(current).length >= MAX_PINS) {
			return { success: false, error: `At most ${MAX_PINS} pinned threads` };
		}
		await db.execute(sql`
			update workspaces
			set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
				'prefPinned',
				coalesce(meta->'prefPinned', '{}'::jsonb) || jsonb_build_object(
					${ctx.userId}::text,
					coalesce(meta->'prefPinned'->${ctx.userId}::text, '{}'::jsonb)
						|| jsonb_build_object(${threadId}::text, ${new Date().toISOString()}::text)
				)
			)
			where id = ${ctx.workspaceId}::uuid
		`);
	} else {
		await db.execute(sql`
			update workspaces
			set meta = meta #- array['prefPinned', ${ctx.userId}::text, ${threadId}::text]
			where id = ${ctx.workspaceId}::uuid and meta ? 'prefPinned'
		`);
	}
	return { success: true };
}

/** Pinned threads present in this mailbox (same rules as the list: RLS, snoozes). */
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
