"use server";
// Content of a message or a whole thread, to copy to the clipboard (it gets pasted all the
// time into AI agents). Read through RLS only: a thread or message invisible to the user
// returns nothing. Text formatting happens in the browser (lib/mail-copy.ts), which has the
// DOM to convert the HTML.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { messageAttachments, messages } from "@db";
import { rlsClient } from "@/lib/actions/clients";

export type CopyAddress = { name?: string | null; address?: string | null };

export type CopyMessage = {
	id: string;
	subject: string | null;
	from: CopyAddress[];
	to: CopyAddress[];
	cc: CopyAddress[];
	date: string | null;
	html: string | null;
	text: string | null;
	attachments: string[];
};

// Addresses of a from/to/cc field: mailparser object ({ value: [...] }) for received
// messages, plain string ("a@b, "Name" <c@d>") for those sent from kurrier.
const addrs = (v: any): CopyAddress[] => {
	if (!v) return [];
	if (Array.isArray(v.value))
		return v.value.map((a: any) => ({ name: a?.name || null, address: a?.address || null }));
	const raw: string = typeof v === "string" ? v : typeof v.text === "string" ? v.text : "";
	return (raw.match(/(?:"[^"]*"|[^,])+/g) ?? [])
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
			return m ? { name: m[1].trim() || null, address: m[2].trim() } : { name: null, address: part };
		});
};

export async function fetchMessagesForCopy(opts: {
	threadId?: string;
	messageId?: string;
}): Promise<CopyMessage[]> {
	if (!opts.threadId && !opts.messageId) return [];
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({
				id: messages.id,
				subject: messages.subject,
				from: messages.from,
				to: messages.to,
				cc: messages.cc,
				date: messages.date,
				createdAt: messages.createdAt,
				html: messages.html,
				text: messages.text,
			})
			.from(messages)
			.where(
				and(
					opts.messageId
						? eq(messages.id, String(opts.messageId))
						: eq(messages.threadId, String(opts.threadId)),
					// The drafts of the thread are not part of the exchange.
					opts.messageId ? undefined : eq(messages.draft, false),
				),
			)
			.orderBy(asc(sql`coalesce(${messages.date}, ${messages.createdAt})`)),
	);
	if (!rows.length) return [];

	const files = await rls((tx) =>
		tx
			.select({
				messageId: messageAttachments.messageId,
				name: messageAttachments.filenameOriginal,
				isInline: messageAttachments.isInline,
			})
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, rows.map((r) => r.id))),
	);

	return rows.map((r) => ({
		id: r.id,
		subject: r.subject,
		from: addrs(r.from),
		to: addrs(r.to),
		cc: addrs(r.cc),
		date: (r.date ?? r.createdAt)?.toISOString() ?? null,
		html: r.html,
		text: r.text,
		attachments: files
			.filter((f) => f.messageId === r.id && !f.isInline && f.name)
			.map((f) => String(f.name)),
	}));
}
