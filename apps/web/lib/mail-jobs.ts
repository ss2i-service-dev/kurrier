import "server-only";

// ss2i (controle d'acces) : jobs IMAP d'une identite, appeles par le serveur seulement
// (creation et suppression d'identite, dashboard.ts) avec une identite deja relue. Ils
// etaient exportes par mailbox.ts ("use server"), donc appelables par n'importe qui avec
// n'importe quel identifiant ; ce module n'est pas un module d'actions.
import { getRedis } from "@/lib/actions/get-redis";

export const backfillMailboxes = async (identityId: string, workspaceId: string) => {
	const { smtpQueue, smtpEvents } = await getRedis();
	const job = await smtpQueue.add(
		"imap:backfill-discover",
		{ identityId, workspaceId },
		{
			jobId: `imap-backfill-discover-${identityId}`,
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 1000,
			},
		},
	);
	await job.waitUntilFinished(smtpEvents);
	backfillAccount(identityId, workspaceId);
};

export const backfillAccount = async (identityId: string, workspaceId: string) => {
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(
		"imap:backfill-account",
		{identityId},
		{
			removeOnComplete: true,
			removeOnFail: false,
			jobId: `imap-backfill-account-${identityId}`,
		},
	);
	await smtpQueue.add(
		"imap:start-idle",
		{ identityId },
		{
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);
};

export const clearImapClients = async (identityId: string) => {
	const { smtpQueue } = await getRedis();
	await smtpQueue.add(
		"imap:stop-idle",
		{ identityId },
		{
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);
};
