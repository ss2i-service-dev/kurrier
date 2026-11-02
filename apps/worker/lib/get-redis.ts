import IORedis from "ioredis";
import { Queue, QueueEvents } from "bullmq";
import { getServerEnv } from "@schema";

const serverConfig = getServerEnv();

const redis = new IORedis({
	maxRetriesPerRequest: null,
	password: serverConfig.REDIS_PASSWORD,
	host: serverConfig.REDIS_HOST || "redis",
	port: Number(serverConfig.REDIS_PORT || 6379),
});

const redisConnection = {
	connection: {
		host: serverConfig.REDIS_HOST || "redis",
		port: Number(serverConfig.REDIS_PORT || 6379),
		password: serverConfig.REDIS_PASSWORD,
	},
};

const smtpQueue = new Queue("smtp-worker", redisConnection);
const smtpEvents = new QueueEvents("smtp-worker", redisConnection);

const sendMailQueue = new Queue("send-mail", redisConnection);
const sendMailEvents = new QueueEvents("send-mail", redisConnection);

const searchIngestQueue = new Queue("search-ingest", redisConnection);
const searchIngestEvents = new QueueEvents("search-ingest", redisConnection);

const commonWorkerQueue = new Queue("common-worker", redisConnection);
const commonWorkerEvents = new QueueEvents("common-worker", redisConnection);

const migrationWorkerQueue = new Queue("migration-worker", redisConnection);
const migrationWorkerEvents = new QueueEvents(
	"migration-worker",
	redisConnection,
);

const davWorkerQueue = new Queue("dav-worker", redisConnection);
const davWorkerEvents = new QueueEvents("dav-worker", redisConnection);

// ss2i : file reservee au rattrapage IMAP. Il tournait dans "smtp-worker", qui ne traite
// qu'un job a la fois : pendant ses heures de travail, suppressions, archivages et drapeaux
// attendaient derriere lui (cf. server/plugins/smtp-worker.ts).
const backfillQueue = new Queue("imap-backfill", redisConnection);

// ss2i : rattachement des fils aux clients de la CRM (section « Clients » des boites
// pro) : un job par fil a l'arrivee d'un message (jobId = fil + identite, retarde pour
// l'anti-rebond) et un job de rattrapage par identite ; worker crm-link-worker.ts.
const crmLinkQueue = new Queue("crm-link", redisConnection);

export async function getRedis() {
	await Promise.all([
		smtpEvents.waitUntilReady(),
		sendMailEvents.waitUntilReady(),
		searchIngestEvents.waitUntilReady(),
		commonWorkerEvents.waitUntilReady(),
		migrationWorkerEvents.waitUntilReady(),
		davWorkerEvents.waitUntilReady(),
	]);
	return {
		connection: redis,
		smtpQueue,
		smtpEvents,
		sendMailQueue,
		sendMailEvents,
		searchIngestQueue,
		searchIngestEvents,
		commonWorkerQueue,
		commonWorkerEvents,
		migrationWorkerQueue,
		migrationWorkerEvents,
		davWorkerQueue,
		davWorkerEvents,
		backfillQueue,
		crmLinkQueue,
	};
}
