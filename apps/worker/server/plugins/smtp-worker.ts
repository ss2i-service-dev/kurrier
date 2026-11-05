import { defineNitroPlugin } from "nitropack/runtime";
import { ImapFlow } from "imapflow";

import { JobScheduler, Worker } from "bullmq";
import { deltaFetch } from "../../lib/imap/imap-delta-fetch";
import { initSmtpClient } from "../../lib/imap/imap-client";
import { mailSetFlags } from "../../lib/imap/imap-flags";
import { moveMail } from "../../lib/imap/imap-move";

import { getRedis } from "../../lib/get-redis";
import { deleteMail } from "../../lib/imap/imap-delete";
import { addNewFolder } from "../../lib/imap/imap-new-folder";
import { deleteFolder } from "../../lib/imap/imap-delete-folder";
import {
	imapIdleSync,
	startRealtimeForIdentity,
	stopRealtimeForIdentity,
} from "../../lib/imap/imap-idle-sync";
import { discoverMailboxes } from "../../lib/imap/backfill/discover/discover-mailboxes";
import {startBackfillForIdentity} from "../../lib/imap/backfill/backfill-full";
import {db, mailboxSync} from "@db";
import { gt } from "drizzle-orm";
import { DRAFT_DELETE_JOB, DRAFT_SYNC_JOB } from "@common";
import { deleteDraftFromImap, syncDraftToImap } from "../../lib/drafts/draft-service";

export default defineNitroPlugin(async (nitroApp) => {
	console.info("**********************SMTP-WORKER***************************");

	const imapInstances = new Map<string, ImapFlow>();
	const idleImapInstances = new Map<string, ImapFlow>();
	// The backfill has its own IMAP connection, separate from the actions'.
	const backfillImapInstances = new Map<string, ImapFlow>();
	const { connection, searchIngestQueue, backfillQueue } = await getRedis();

	// A backfill chains windows until the day's quota is used, i.e. several hours on a large
	// mailbox. This worker only processes one job at a time: while the backfill ran here, the
	// mail:move, mail:set-flags and mail:delete-permanent jobs of ALL mailboxes stayed queued
	// (the UI said "moved to Trash" and nothing moved). The backfill therefore goes to its own
	// queue; the same jobId avoids duplicates there.
	const enqueueBackfill = (identityId: string) =>
		backfillQueue.add(
			"imap:backfill-account",
			{ identityId },
			{
				removeOnComplete: true,
				removeOnFail: true,
				jobId: `imap-backfill-account-${identityId}`,
			},
		);

	const backfillWorker = new Worker(
		"imap-backfill",
		async (job) => {
			const { identityId } = job.data as { identityId: string };
			await startBackfillForIdentity(identityId, backfillImapInstances);
			return { success: true };
		},
		// 4 simultaneous backfills; at 2, a new mailbox would wait for hours for the running
		// backfills (mailboxes with tens of thousands of messages) to finish.
		{ connection, concurrency: 4, lockDuration: 5 * 60 * 1000 },
	);
	backfillWorker.on("failed", (job, err) => {
		console.info(`[BACKFILL] ${job?.id} has failed with ${err.message}`);
	});
	backfillWorker.on("error", (err) => {
		console.info(`[BACKFILL] worker has failed with ${err.message}`);
	});

	const worker = new Worker(
		"smtp-worker",
		async (job) => {
			if (job.name === "delta-fetch") {
				const identityId = job.data.identityId;
				await deltaFetch(identityId, imapInstances).catch((err) => {
					console.error(
						`delta-fetch job failed for identityId ${identityId}:`,
						err,
					);
				});
			} else if (job.name === "mail:move") {
				if (job.data.op === "move" && !job.data.toMailboxId) {
					throw new Error("mail:move requires toMailboxId when op === 'move'");
				}
				// moveMail fails when some messages could not be moved over IMAP (put back in the source
				// in the database, job retried); the index is refreshed anyway.
				try {
					await moveMail(job.data, imapInstances);
				} finally {
					const movedIds: string[] = job.data.threadIds?.length
						? job.data.threadIds
						: [job.data.threadId];
					for (const threadId of movedIds) {
						await searchIngestQueue.add(
							"refresh-thread",
							{ threadId },
							{
								jobId: `refresh-${threadId}`, // collapses duplicates
								removeOnComplete: true,
								removeOnFail: false,
								attempts: 3,
								backoff: { type: "exponential", delay: 1500 },
							},
						);
					}
				}
			} else if (job.name === "mail:set-flags") {
				await mailSetFlags(job.data, imapInstances);
				await searchIngestQueue.add(
					"refresh-thread",
					{ threadId: job.data.threadId },
					{
						jobId: `refresh-${job.data.threadId}`, // collapses duplicates
						removeOnComplete: true,
						removeOnFail: false,
						attempts: 3,
						backoff: { type: "exponential", delay: 1500 },
					},
				);
			} else if (job.name === "mail:delete-permanent") {
				await deleteMail(job.data, imapInstances);
			} else if (job.name === DRAFT_SYNC_JOB) {
				// Drafts, IMAP version (see lib/drafts/draft-service.ts).
				await syncDraftToImap(job.data, imapInstances);
			} else if (job.name === DRAFT_DELETE_JOB) {
				await deleteDraftFromImap(job.data, imapInstances);
			} else if (job.name === "smtp:append:sent") {
			} else if (job.name === "imap:backfill-account") {
				// Plain relay to the backfill queue (the web app keeps posting here).
				const { identityId } = job.data as { identityId: string };
				await enqueueBackfill(identityId);
				return { success: true };
			} else if (job.name === "imap:resume-backfills") {

				const rows = await db
					.selectDistinct({
						identityId: mailboxSync.identityId,
					})
					.from(mailboxSync)
					// The realtime sync sets `phase` back to IDLE on every pass, so a resume based on the
					// phase would find nothing after the first hour. What says that backfill remains is the
					// cursor.
					.where(gt(mailboxSync.backfillCursorUid, 0));
				for (const row of rows) {
					await enqueueBackfill(row.identityId);
				}
				return { success: true };
			} else if (job.name === "imap:backfill-discover") {
				const identityId = job.data.identityId;
				const workspaceId = job.data.workspaceId;
				const client = await initSmtpClient(identityId, imapInstances);
				if (client?.authenticated && client?.usable) {
					await discoverMailboxes(client, identityId, workspaceId);
				}
			} else if (job.name === "mailbox:add-new") {
				const identityId = job.data.identityId;
				const client = await initSmtpClient(identityId, imapInstances);
				if (client) {
					await addNewFolder(job.data, client);
				}
			} else if (job.name === "mailbox:delete-folder") {
				const identityId = job.data.identityId;
				const client = await initSmtpClient(identityId, imapInstances);
				if (client) {
					await deleteFolder(job.data, client);
				}
			} else if (job.name === "imap:start-idle") {
				const identityId = job.data.identityId as string;
				void startRealtimeForIdentity(identityId, idleImapInstances, imapInstances).catch(
					(err) => console.error(`startRealtimeForIdentity failed ${identityId}`, err),
				);
			} else if (job.name === "imap:stop-idle") {
				const identityId = job.data.identityId as string;
				await stopRealtimeForIdentity(
					identityId,
					idleImapInstances,
					imapInstances,
				);
			}
			return { success: true };
		},
		{ connection },
	);

	void imapIdleSync(idleImapInstances, imapInstances).catch((err) => {
		console.error("imapIdleSync failed", err);
	});

	const scheduler = new JobScheduler("smtp-worker", { connection });

	await scheduler.upsertJobScheduler(
		"imap-resume-backfills-scheduler",
		// Every hour rather than every 24 h. An identity's daily quota expires 24 h after its first
		// initialization, which does not coincide with the scheduler's time: with one pass per day,
		// an identity would only resume every other day.
		{ every: 60 * 60 * 1000 },
		"imap:resume-backfills",
		{},
		{
			removeOnComplete: true,
			removeOnFail: true,
			attempts: 1,
		},
		{ override: true },

	);

	worker.on("completed", async (job) => {
		console.info("job", job.name);
		console.info(`[SMTP] ${job.id} has completed!`);
	});

	worker.on("failed", (job, err) => {
		console.info(`${job?.id} has failed with ${err.message}`);
	});
	worker.on("error", (err) => {
		console.info(`[SMTP] worker has failed with ${err.message}`);
	});

	nitroApp.hooks.hookOnce("close", async () => {
		console.info("Closing nitro server...");
		try {
			const logoutAll = async (label: string, map: Map<string, ImapFlow>) => {
				for (const [identityId, client] of map) {
					try {
						await client.logout();
						console.info(
							`[${label}] Logged out from IMAP server for identityId: ${identityId}`,
						);
					} catch (err) {
						console.error(
							`[${label}] Failed to logout cleanly for identityId: ${identityId}`,
							err,
						);
					}
				}
				map.clear();
				console.info(`[${label}] IMAP map cleared`);
			};

			await logoutAll("command", imapInstances);
			await logoutAll("realtime", idleImapInstances);
			await logoutAll("backfill", backfillImapInstances);
			console.info("Logged out from IMAP servers");
			try {
				await Promise.allSettled([
					worker?.close(),
					// Without waiting for the running backfill to finish (it lasts hours); the job stays in
					// the queue and resumes on restart, from its cursor.
					backfillWorker?.close(true),
					scheduler?.close(),
				]);
			} catch (err: any) {
				console.error("Error closing BullMQ resources:", err?.message ?? err);
			}

		} catch (err) {
			console.error("Failed to logout cleanly", err);
		}
		console.info("Task is done!");
	});
});
