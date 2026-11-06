import "server-only";

// IMAP jobs of an identity, called by the server only (identity creation and deletion,
// dashboard.ts) with an identity that was already re-read. They used to be exported by
// mailbox.ts ("use server"), hence callable by anyone with any identifier; this module is
// not an actions module.
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

// Restarts the real-time sync of an identity and lifts its suspension for a refused password (the worker
// resets the failures before opening). Called when an SMTP/IMAP account is saved, for each identity that
// uses it (smtp-account-idle.ts).
export const restartImapIdle = async (identityId: string) => {
	const { smtpQueue } = await getRedis();
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
