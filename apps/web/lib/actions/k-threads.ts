"use server";
// SS2i (Outlook) : page suivante de la liste des fils, pour le chargement au
// defilement. Memes requetes que la page serveur (RLS via fetchMailboxThreads).
import { fetchMailboxThreads } from "@/lib/actions/mailbox";
import { fetchMailboxThreadLabels } from "@/lib/actions/labels";

export async function fetchKThreadPage(identityPublicId: string, mailboxSlug: string, page: number) {
	const mailboxThreads = await fetchMailboxThreads(identityPublicId, mailboxSlug, page);
	const labelsByThreadId = mailboxThreads.length ? await fetchMailboxThreadLabels(mailboxThreads) : {};
	return { mailboxThreads, labelsByThreadId };
}
