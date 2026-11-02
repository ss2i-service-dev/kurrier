import { db, mailSubscriptions } from "@db";
import { sql } from "drizzle-orm";
import { extractListUnsubscribe, subscriptionKeyOf } from "@common";

// ss2i : cree ou met a jour l'abonnement (mail_subscriptions) d'un message porteur d'en-tetes
// List-*. Appele par l'ingestion (message-payload-parser) et par le rattrapage. Ne touche
// jamais au statut : un abonnement « unsubscribed » le reste. Une valeur absente du message
// n'efface pas celle deja connue (un message sans List-Unsubscribe ne retire rien). Rend la cle, ou null si rien a enregistrer.
// `headers` est la forme headers_json (mailparser : cle `list`, ou en-tetes bruts).
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
				// Le drapeau suit l'URL : il ne change que si le message en porte une.
				oneClick: sql`CASE WHEN excluded.unsubscribe_http_url IS NOT NULL THEN excluded.one_click ELSE ${mailSubscriptions.oneClick} END`,
				// Un rattrapage rejoue des messages anciens : lastSeenAt ne recule jamais.
				lastSeenAt: sql`GREATEST(excluded.last_seen_at, ${mailSubscriptions.lastSeenAt})`,
			},
		});
	return subscriptionKey;
}
