import { db, mailSubscriptions } from "@db";
import { sql } from "drizzle-orm";
import { extractListUnsubscribe, subscriptionKeyOf } from "@common";

// Creates or updates the subscription (mail_subscriptions) of a message carrying List-*
// headers. Called by ingestion (message-payload-parser) and by the backfill. Never touches
// the status: an "unsubscribed" subscription stays so. A value missing from the message does
// not erase the one already known (a message without List-Unsubscribe removes nothing).
// Returns the key, or null if there is nothing to record.
// `headers` is the headers_json shape (mailparser: `list` key, or raw headers).
export async function upsertMailSubscription(opts: {
	ownerId: string;
	workspaceId: string;
	headers: Record<string, any> | null | undefined;
	fromEmail?: string | null;
	seenAt?: Date;
}): Promise<string | null> {
	const info = extractListUnsubscribe(opts.headers);
	if (!info.listId && !info.httpUrl && !info.mailto) return null;
	const subscriptionKey = subscriptionKeyOf(info, opts.fromEmail);
	if (!subscriptionKey) return null;

	const seenAt = opts.seenAt ?? new Date();
	await db
		.insert(mailSubscriptions)
		.values({
			ownerId: opts.ownerId,
			workspaceId: opts.workspaceId,
			subscriptionKey,
			listId: info.listId,
			unsubscribeHttpUrl: info.httpUrl,
			unsubscribeMailto: info.mailto,
			oneClick: info.oneClick,
			lastSeenAt: seenAt,
		} as any)
		.onConflictDoUpdate({
			target: [
				mailSubscriptions.workspaceId,
				mailSubscriptions.ownerId,
				mailSubscriptions.subscriptionKey,
			],
			set: {
				listId: sql`COALESCE(excluded.list_id, ${mailSubscriptions.listId})`,
				unsubscribeHttpUrl: sql`COALESCE(excluded.unsubscribe_http_url, ${mailSubscriptions.unsubscribeHttpUrl})`,
				unsubscribeMailto: sql`COALESCE(excluded.unsubscribe_mailto, ${mailSubscriptions.unsubscribeMailto})`,
				// The flag follows the URL: it only changes if the message carries one.
				oneClick: sql`CASE WHEN excluded.unsubscribe_http_url IS NOT NULL THEN excluded.one_click ELSE ${mailSubscriptions.oneClick} END`,
				// A backfill replays old messages: lastSeenAt never goes backwards.
				lastSeenAt: sql`GREATEST(excluded.last_seen_at, ${mailSubscriptions.lastSeenAt})`,
			},
		});
	return subscriptionKey;
}
