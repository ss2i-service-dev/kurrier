"use server";

import { sql } from "drizzle-orm";
import { rlsClient } from "@/lib/actions/clients";

// Threads of the Spam mailbox whose sender is probably legitimate: address already seen
// in the inbox, the archive or a mailbox of the identity, or an address we have already
// written to. The address book is not used as a criterion: kurrier adds every sender
// received to it, spam included.
export async function findLikelyNotSpam(spamMailboxId: string): Promise<string[]> {
	if (!spamMailboxId) return [];
	const rls = await rlsClient();
	const res: any = await rls((tx) =>
		tx.execute(sql`
			with box as (
				select identity_id from mailboxes where id = ${spamMailboxId}::uuid and kind = 'spam'
			),
			spam as (
				select m.thread_id, lower(m."from"->'value'->0->>'address') as addr
				from messages m
				where m.mailbox_id = ${spamMailboxId}::uuid
			),
			legit as (
				select distinct lower(m."from"->'value'->0->>'address') as addr
				from messages m
				join mailboxes mb on mb.id = m.mailbox_id
				where mb.identity_id = (select identity_id from box)
				  and mb.kind in ('inbox', 'archive', 'custom')
			),
			written as (
				select distinct lower(x->>'address') as addr
				from messages m
				join mailboxes mb on mb.id = m.mailbox_id,
				jsonb_array_elements(coalesce(m."to"->'value', '[]'::jsonb) || coalesce(m.cc->'value', '[]'::jsonb)) x
				where mb.identity_id = (select identity_id from box)
				  and mb.kind = 'sent'
			)
			select distinct s.thread_id
			from spam s
			where s.addr is not null
			  and (s.addr in (select addr from legit) or s.addr in (select addr from written))
		`),
	);
	const rows = Array.isArray(res) ? res : (res?.rows ?? []);
	return rows.map((r: any) => String(r.thread_id));
}
