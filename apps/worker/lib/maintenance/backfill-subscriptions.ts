import { db, messages } from "@db";
import { and, asc, gt, sql } from "drizzle-orm";
import { extractListUnsubscribe, subscriptionKeyOf } from "@common";
import { upsertMailSubscription } from "../mail-subscriptions";

// ss2i : rattrapage des abonnements (mail_subscriptions) sur les messages deja en base.
// Idempotent et non destructif : upsertMailSubscription ne touche jamais au statut ni
// n'efface une valeur connue, et lastSeenAt ne recule pas. Les messages sont lus par lots
// (curseur sur l'id), dedoublonnes par (utilisateur, cle) en gardant le plus recent, puis
// une seule ecriture par abonnement.
// Lancement : variable d'environnement KURRIER_BACKFILL_SUBSCRIPTIONS=1 du worker, executee
// une fois au demarrage (plugin ss2i-maintenance), sans bloquer le demarrage.
const BATCH = 1000;

export async function backfillMailSubscriptions(log: (m: string) => void = console.log) {
	// Anciennes lignes (cle https://host/chemin, avant migration des cles) deja desinscrites :
	// leur statut doit survivre au changement de cle. Indexees par (utilisateur, URL).
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
	// Nouvelle ligne (utilisateur|workspace|cle) -> ancienne ligne desinscrite a reporter.
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
				// URL identique seulement : l'ancienne cle (host + chemin) est partagee par tous les
				// clients d'un meme routeur et reporterait le statut sur des expediteurs etrangers.
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
		log(`[backfill-subscriptions] ${scanned} messages lus, ${latest.size} abonnements distincts`);
	}

	let written = 0;
	for (const v of latest.values()) {
		if (await upsertMailSubscription(v)) written++;
	}

	// Report du statut : une ancienne ligne « unsubscribed » (meme utilisateur, meme URL) donne
	// son statut et sa date a la nouvelle ligne. Jamais l'inverse : une nouvelle ligne deja
	// « unsubscribed » n'est pas touchee.
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

	// Fin du rattrapage complet : les anciennes lignes (cle ni list-id:, from:, mailto: ni url:)
	// ne peuvent plus etre retrouvees a l'affichage. Une ancienne ligne « unsubscribed » dont le
	// statut n'a pas pu etre reporte (plus de message en base, URL differente) est gardee.
	const removed = await db.execute(sql`
		DELETE FROM mail_subscriptions o
		WHERE o.subscription_key NOT LIKE 'list-id:%' AND o.subscription_key NOT LIKE 'from:%'
		  AND o.subscription_key NOT LIKE 'mailto:%' AND o.subscription_key NOT LIKE 'url:%'
		  AND (o.status <> 'unsubscribed'${carriedOldIds.length ? sql` OR o.id IN (${sql.join(carriedOldIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``})
	`);
	const nRemoved = Number((removed as any)?.count ?? (removed as any)?.rowCount ?? 0);
	log(
		`[backfill-subscriptions] termine : ${scanned} messages, ${written} abonnements crees ou mis a jour, ${carried} statuts unsubscribed reportes, ${nRemoved} anciennes lignes supprimees`,
	);
	return { scanned, written, carried, removed: nRemoved };
}
