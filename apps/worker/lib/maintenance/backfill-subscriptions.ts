import { db, messages } from "@db";
import { and, asc, gt, sql } from "drizzle-orm";
import { extractListUnsubscribe, subscriptionKeyOf } from "@common";
import { upsertMailSubscription } from "../mail-subscriptions";

// Backfills subscriptions (mail_subscriptions) from messages already in the database.
// Idempotent and non-destructive: upsertMailSubscription never touches the status nor
// erases a known value, and lastSeenAt never goes backwards. Messages are read in batches
// (cursor on the id), deduplicated by (user, key) keeping the most recent, then written once
// per subscription.
// Launch: KURRIER_BACKFILL_SUBSCRIPTIONS=1 in the worker environment, run once at startup
// (maintenance plugin), without blocking startup.
const BATCH = 1000;

export async function backfillMailSubscriptions(log: (m: string) => void = console.log) {
	// Legacy rows (key https://host/path, from before the key format changed) already unsubscribed:
	// their status must survive the key change. Indexed by (user, URL).
	const oldRows = (await db.execute(sql`
		SELECT id, owner_id, subscription_key, unsubscribe_http_url, unsubscribed_at
		FROM mail_subscriptions
		WHERE status = 'unsubscribed' AND subscription_key NOT LIKE 'list-id:%' AND subscription_key NOT LIKE 'from:%'
		  AND subscription_key NOT LIKE 'mailto:%' AND subscription_key NOT LIKE 'url:%'
	`)) as unknown as Array<{ id: string; owner_id: string; subscription_key: string; unsubscribe_http_url: string | null; unsubscribed_at: Date | null }>;
	const oldBy = new Map<string, (typeof oldRows)[number]>();
	for (const o of oldRows) {
		if (o.unsubscribe_http_url) oldBy.set(`${o.owner_id}|${o.unsubscribe_http_url}`, o);
	}
	// New row (user|workspace|key) -> legacy unsubscribed row to carry over.
	const carry = new Map<string, { owner: string; workspace: string; key: string; old: (typeof oldRows)[number] }>();

	let cursor = "00000000-0000-0000-0000-000000000000";
	let scanned = 0;
	const latest = new Map<
		string,
		{ ownerId: string; workspaceId: string; headers: any; fromEmail: string | null; seenAt: Date }
	>();

	for (;;) {
		const rows = await db
			.select({
				id: messages.id,
				ownerId: messages.ownerId,
				workspaceId: messages.workspaceId,
				from: messages.from,
				date: messages.date,
				createdAt: messages.createdAt,
				headersJson: messages.headersJson,
			})
			.from(messages)
			.where(
				and(
					gt(messages.id, cursor),
					sql`(${messages.headersJson} -> 'list' ? 'unsubscribe' OR ${messages.headersJson} ? 'list-unsubscribe')`,
				),
			)
			.orderBy(asc(messages.id))
			.limit(BATCH);
		if (!rows.length) break;
		cursor = rows[rows.length - 1].id;
		scanned += rows.length;

		for (const r of rows) {
			const headers = r.headersJson as any;
			const info = extractListUnsubscribe(headers);
			const fromEmail = ((r.from as any)?.value?.[0]?.address ?? "").trim().toLowerCase() || null;
			const key = subscriptionKeyOf(info, fromEmail);
			if (!key || (!info.httpUrl && !info.mailto && !info.listId)) continue;
			if (oldRows.length && info.httpUrl) {
				// Identical URL only: the legacy key (host + path) is shared by all customers of a same
				// router and would carry the status over to unrelated senders.
				const old = oldBy.get(`${r.ownerId}|${info.httpUrl}`);
				if (old) carry.set(`${r.ownerId}|${r.workspaceId}|${key}`, { owner: r.ownerId, workspace: r.workspaceId, key, old });
			}
			const seenAt = new Date(r.date ?? r.createdAt ?? Date.now());
			const k = `${r.ownerId}|${r.workspaceId}|${key}`;
			const prev = latest.get(k);
			if (!prev || prev.seenAt <= seenAt) {
				latest.set(k, {
					ownerId: r.ownerId,
					workspaceId: r.workspaceId,
					headers,
					fromEmail,
					seenAt,
				});
			}
		}
		log(`[backfill-subscriptions] ${scanned} messages read, ${latest.size} distinct subscriptions`);
	}

	let written = 0;
	for (const v of latest.values()) {
		if (await upsertMailSubscription(v)) written++;
	}

	// Status carry-over: a legacy "unsubscribed" row (same user, same URL) gives its status
	// and date to the new row. Never the other way round: a new row already "unsubscribed"
	// is left alone.
	const carriedOldIds: string[] = [];
	let carried = 0;
	for (const c of carry.values()) {
		const res = await db.execute(sql`
			UPDATE mail_subscriptions
			SET status = 'unsubscribed', unsubscribed_at = ${c.old.unsubscribed_at}, updated_at = now()
			WHERE owner_id = ${c.owner} AND workspace_id = ${c.workspace} AND subscription_key = ${c.key} AND status <> 'unsubscribed'
		`);
		carried += Number((res as any)?.count ?? 0);
		carriedOldIds.push(c.old.id);
	}

	// End of the full backfill: legacy rows (key not starting with list-id:, from:, mailto: or
	// url:) can no longer be found at display time. A legacy "unsubscribed" row whose status
	// could not be carried over (no message left in the database, different URL) is kept.
	const removed = await db.execute(sql`
		DELETE FROM mail_subscriptions o
		WHERE o.subscription_key NOT LIKE 'list-id:%' AND o.subscription_key NOT LIKE 'from:%'
		  AND o.subscription_key NOT LIKE 'mailto:%' AND o.subscription_key NOT LIKE 'url:%'
		  AND (o.status <> 'unsubscribed'${carriedOldIds.length ? sql` OR o.id IN (${sql.join(carriedOldIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``})
	`);
	const nRemoved = Number((removed as any)?.count ?? (removed as any)?.rowCount ?? 0);
	log(
		`[backfill-subscriptions] done: ${scanned} messages, ${written} subscriptions created or updated, ${carried} unsubscribed statuses carried over, ${nRemoved} legacy rows removed`,
	);
	return { scanned, written, carried, removed: nRemoved };
}
