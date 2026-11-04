"use server";
// ss2i : contenu d'un message ou d'un fil entier, pour le copier dans le presse-papiers
// (on le colle sans arret dans des agents IA). Lecture par RLS seulement : un fil ou un
// message invisible pour l'utilisateur ne renvoie rien. Mise en texte cote navigateur
// (lib/mail-copy.ts), qui a le DOM pour convertir le HTML.
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

// Adresses d'un champ from/to/cc : objet mailparser ({ value: [...] }) pour les messages
// recus, simple chaine (« a@b, "Nom" <c@d> ») pour ceux envoyes depuis kurrier.
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
					// Les brouillons du fil ne font pas partie de l'echange.
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
