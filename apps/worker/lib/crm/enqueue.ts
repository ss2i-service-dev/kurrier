import { db, mailboxes } from "@db";
import { inArray } from "drizzle-orm";
import { getRedis } from "../get-redis";

// ss2i clients : mise en file du rattachement d'un fil a ses clients (section
// « Clients » des boites pro), depuis l'ingestion (message-payload-parser.ts) et
// l'envoi (send-mail.ts). Delai avant le rattachement : une reponse arrive souvent dans
// la foulee, et le meme jobId (fil + identite) absorbe les arrivees suivantes tant que
// le job n'a pas demarre.
export const CRM_LINK_DELAY_MS = 45_000;

export type CrmLinkRequest = { threadId: string; mailboxId: string };

export async function enqueueCrmLinkByIdentity(threadId: string, identityId: string) {
	const { crmLinkQueue } = await getRedis();
	await crmLinkQueue.add(
		"crm:link-thread",
		{ threadId, identityId },
		{
			jobId: `crm-link-${threadId}-${identityId}`,
			delay: CRM_LINK_DELAY_MS,
			removeOnComplete: true,
			removeOnFail: true,
			attempts: 2,
		},
	);
}

/** Un job par (fil, identite du dossier), dedoublonne dans le lot. */
export async function enqueueCrmLinks(requests: CrmLinkRequest[]) {
	if (!requests.length) return;
	const mailboxIds = Array.from(new Set(requests.map((j) => j.mailboxId)));
	const owners = await db
		.select({ id: mailboxes.id, identityId: mailboxes.identityId })
		.from(mailboxes)
		.where(inArray(mailboxes.id, mailboxIds));
	const identityByMailbox = new Map(owners.map((o) => [o.id, o.identityId]));
	const seen = new Set<string>();
	for (const j of requests) {
		const identityId = identityByMailbox.get(j.mailboxId);
		if (!identityId) continue;
		const key = `${j.threadId}:${identityId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		await enqueueCrmLinkByIdentity(j.threadId, identityId);
	}
}
