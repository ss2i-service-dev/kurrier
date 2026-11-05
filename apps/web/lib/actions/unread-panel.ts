"use server";

import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db, mailboxThreads, workspaceMembers, workspaces } from "@db";
import { getWorkspaceId, rlsClient } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";

// Side panel of unread threads, next to an open thread. Per-user option, disabled by
// default, stored in workspaces.meta.prefUnreadPanel[<userId>] (same principle as remote
// images, contact-images.ts): it follows the user from one device to another.

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

export async function unreadPanelEnabled() {
	try {
		const ctx = await context();
		if (!ctx) return false;
		const [row] = await db
			.select({
				on: sql<boolean>`coalesce((${workspaces.metaData}->'prefUnreadPanel'->>${ctx.userId}::text)::boolean, false)`,
			})
			.from(workspaces)
			.where(eq(workspaces.id, ctx.workspaceId))
			.limit(1);
		return Boolean(row?.on);
	} catch {
		return false;
	}
}

export async function setUnreadPanelEnabled(enabled: boolean) {
	const ctx = await context();
	if (!ctx) return { success: false, error: "Not authenticated" };
	await db.execute(sql`
		update workspaces
		set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'prefUnreadPanel',
			coalesce(meta->'prefUnreadPanel', '{}'::jsonb)
				|| jsonb_build_object(${ctx.userId}::text, ${Boolean(enabled)}::boolean)
		)
		where id = ${ctx.workspaceId}::uuid
	`);
	// The thread layout reads the option: it must be rebuilt.
	revalidatePath("/", "layout");
	return { success: true };
}

const PANEL_LIMIT = 100;

// Unread threads of a mailbox, most recent first. The open thread is always returned,
// even once read, so that the list does not jump.
export async function fetchUnreadPanelThreads(
	identityPublicId: string,
	mailboxSlug: string,
	currentThreadId?: string | null,
) {
	const rls = await rlsClient();
	const now = new Date();
	const unreadOrCurrent = currentThreadId
		? or(gt(mailboxThreads.unreadCount, 0), eq(mailboxThreads.threadId, currentThreadId))
		: gt(mailboxThreads.unreadCount, 0);

	const rows = await rls((tx) =>
		tx
			.select({
				threadId: mailboxThreads.threadId,
				mailboxId: mailboxThreads.mailboxId,
				subject: mailboxThreads.subject,
				previewText: mailboxThreads.previewText,
				lastActivityAt: mailboxThreads.lastActivityAt,
				unreadCount: mailboxThreads.unreadCount,
				messageCount: mailboxThreads.messageCount,
				hasAttachments: mailboxThreads.hasAttachments,
				participants: mailboxThreads.participants,
			})
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.identityPublicId, identityPublicId),
					eq(mailboxThreads.mailboxSlug, mailboxSlug),
					unreadOrCurrent,
					or(isNull(mailboxThreads.snoozedUntil), lte(mailboxThreads.snoozedUntil, now)),
				),
			)
			.orderBy(desc(mailboxThreads.lastActivityAt), desc(mailboxThreads.threadId))
			.limit(PANEL_LIMIT),
	);

	return rows.map((r) => ({
		...r,
		lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
	}));
}

export type UnreadPanelThread = Awaited<ReturnType<typeof fetchUnreadPanelThreads>>[number];
