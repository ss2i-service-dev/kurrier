"use server";
// Inbox pulse, polled every 20 s by the browser to spot a new message (list refreshed;
// in the modern interface, sound, badge and counter in the tab title). Under RLS, two index
// reads:
//  - latest: date of the last message received in the Inboxes (index
//    idx_messages_mailbox_date). It only advances when a message arrives: marking a
//    thread unread, unarchiving an old message or replying does not change it
//    (otherwise, false "new message");
//  - unread: number of unread Inbox threads (index ix_mbth_mailbox_unread),
//    like the sidebar counter.
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
