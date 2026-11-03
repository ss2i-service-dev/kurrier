"use server";
// SS2i : pouls de la boite de reception, interroge toutes les 20 s par le
// navigateur pour reperer un nouveau message (liste actualisee ; en Outlook, son,
// pastille et compteur dans le titre de l'onglet). Sous RLS, deux lectures
// d'index :
//  - latest : date du dernier message recu dans les Inbox (index
//    idx_messages_mailbox_date). Elle n'avance qu'a l'arrivee d'un message :
//    remettre un fil en non lu, desarchiver un vieux message ou repondre ne la
//    change pas (sinon, faux « nouveau message ») ;
//  - unread : nombre de fils non lus de l'Inbox (index ix_mbth_mailbox_unread),
//    comme le compteur de la barre laterale.
import { sql } from "drizzle-orm";
import { rlsClient } from "@/lib/actions/clients";

export async function kInboxPulse(): Promise<{ unread: number; latest: string | null } | null> {
	try {
		const rls = await rlsClient();
		const res: any = await rls((tx) =>
			tx.execute(sql`
				with inbox as (select id from mailboxes where slug = 'inbox')
				select
					(select count(*) from mailbox_threads mt
					  where mt.mailbox_id in (select id from inbox)
					    and mt.unread_count > 0
					    and (mt.snoozed_until is null or mt.snoozed_until <= now())) as unread,
					(select max(last_date) from (
						select (select m.date from messages m
						         where m.mailbox_id = i.id and m.date is not null
						         order by m.date desc limit 1) as last_date
						from inbox i
					) d) as latest
			`),
		);
		const row = (res?.rows ?? res ?? [])[0] ?? {};
		const latest = row.latest ? new Date(row.latest).toISOString() : null;
		return { unread: Number(row.unread ?? 0), latest };
	} catch {
		return null;
	}
}
