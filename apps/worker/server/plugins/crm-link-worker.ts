import { defineNitroPlugin } from "nitropack/runtime";
import { JobScheduler, Worker } from "bullmq";
import { getRedis } from "../../lib/get-redis";
import { crmConfigured } from "../../lib/crm/crm-client";
import { backfillIdentity, identitiesDueForBackfill, linkThread } from "../../lib/crm/link-thread";

// ss2i : section « Clients » des boites pro. File `crm-link` : un job par fil a
// l'arrivee d'un message (message-payload-parser.ts, retarde et dedoublonne par jobId)
// et un job de rattrapage par identite pro, lance toutes les heures pour les identites
// qui le doivent (jamais faite, interrompue, trop vieille, ou fils arrives depuis). Un
// seul job a la fois : le debit vers la CRM est tenu par crm-client.ts, et le
// rattrapage n'a pas a concurrencer les fils du jour (sa passe suivante les reprend).
// Sans CRM_LORE_TOKEN, le worker ne fait rien.

export default defineNitroPlugin(async (nitroApp) => {
	if (!crmConfigured()) {
		console.info("[crm-link] CRM_LORE_TOKEN absent : rattachement aux clients desactive");
		return;
	}
	const { connection, crmLinkQueue } = await getRedis();
	let closing = false;

	const worker = new Worker(
		"crm-link",
		async (job) => {
			switch (job.name) {
				case "crm:link-thread": {
					const { threadId, identityId } = job.data as { threadId: string; identityId: string };
					const r = await linkThread(threadId, identityId);
					return { success: true, ...r };
				}
				case "crm:backfill-identity": {
					const { identityId } = job.data as { identityId: string };
					const r = await backfillIdentity(identityId, () => closing);
					console.info(
						`[crm-link] backfill ${identityId}: processed=${r.processed} linked=${r.linked}${r.skipped ? " (skipped)" : ""}${"stopped" in r && r.stopped ? " (stopped)" : ""}`,
					);
					return { success: true, ...r };
				}
				case "crm:resume-backfills": {
					const due = await identitiesDueForBackfill();
					for (const identityId of due) {
						await crmLinkQueue.add(
							"crm:backfill-identity",
							{ identityId },
							{ jobId: `crm-backfill-${identityId}`, removeOnComplete: true, removeOnFail: true, attempts: 1 },
						);
					}
					return { success: true, due: due.length };
				}
				default:
					return { success: true };
			}
		},
		// Un rattrapage dure longtemps : le verrou est renouvele par BullMQ tant que le job tourne.
		{ connection, concurrency: 1, lockDuration: 5 * 60 * 1000 },
	);

	const scheduler = new JobScheduler("crm-link", { connection });
	await scheduler.upsertJobScheduler(
		"crm-resume-backfills-scheduler",
		{ every: 60 * 60 * 1000 },
		"crm:resume-backfills",
		{},
		{ removeOnComplete: true, removeOnFail: true, attempts: 1 },
		{ override: true },
	);
	// Premiere passe sans attendre l'heure.
	await crmLinkQueue.add(
		"crm:resume-backfills",
		{},
		{ jobId: "crm-resume-backfills-boot", removeOnComplete: true, removeOnFail: true, attempts: 1 },
	);

	worker.on("failed", (job, err) => {
		console.info(`[crm-link] ${job?.id} has failed with ${err.message}`);
	});
	worker.on("error", (err) => {
		console.info(`[crm-link] worker has failed with ${err.message}`);
	});

	nitroApp.hooks.hookOnce("close", async () => {
		closing = true;
		try {
			// Sans attendre la fin d'un rattrapage : il reprend sur son curseur au redemarrage.
			await Promise.allSettled([worker.close(true), scheduler.close()]);
		} catch (err: any) {
			console.error("Error closing crm-link worker:", err?.message ?? err);
		}
	});
});
