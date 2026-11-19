// Archiver avec une duree de vie (docs/plans/archive-duree-de-vie.md, bloc 2) : le tick
// mail:expire-tick poste un job mail:move (op trash, expiry: true) par dossier Archive qui a des
// fils dus, avec un jobId stable dans l'heure ; il ne touche jamais l'echeance d'un fil du (c'est le
// move qui la vide) et remet a NULL celle des lignes hors Archive ou qui ont une ligne Inbox soeur.
// Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55437/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/expire-tick.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { expiryBucket, upsertMailboxThreadItem } from "@common";
import { and, eq } from "drizzle-orm";
import { runExpiryTick } from "../lib/mail-expiry";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

async function folderOf(f: Fixture, kind: "archive" | "custom", name: string) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind,
			name,
			slug: kind === "custom" ? name.toLowerCase() : kind,
			isDefault: false,
			metaData: { imap: { path: name } },
		})
		.returning();
	return row;
}

// Un fil d'un message dans `mailboxId`, ou un message de plus dans le fil `existing`.
async function msgIn(f: Fixture, mailboxId: string, existing?: string): Promise<string> {
	const threadId =
		existing ?? (await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() }).returning())[0].id;
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: `<tick-${Math.random().toString(36).slice(2)}@x>`,
			subject: "fil",
			text: "corps",
			date: new Date(),
			seen: true,
			metaData: {},
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return threadId;
}

const row = async (threadId: string, mailboxId: string) =>
	(await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId))))[0];

const setExp = (threadId: string, mailboxId: string, at: Date | null) =>
	db
		.update(mailboxThreads)
		.set({ expiresAt: at })
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));

type Call = { name: string; data: any; opts: any };

async function tick(now: Date) {
	const calls: Call[] = [];
	await runExpiryTick({ now, enqueue: async (name, data, opts) => void calls.push({ name, data, opts }) });
	return calls;
}

async function main() {
	const now = new Date();
	const PAST = new Date(now.getTime() - 3_600_000);
	const FUTURE = new Date(now.getTime() + 30 * 86_400_000);

	const f = await createUserFixture("expire-tick");
	const archive = await folderOf(f, "archive", "Archive");
	const custom = await folderOf(f, "custom", "Projets");

	const due = await msgIn(f, archive.id);
	await setExp(due, archive.id, PAST);
	const notDue = await msgIn(f, archive.id);
	await setExp(notDue, archive.id, FUTURE);
	const starred = await msgIn(f, archive.id);
	await db.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, starred), eq(mailboxThreads.mailboxId, archive.id)));
	await setExp(starred, archive.id, PAST);
	const sister = await msgIn(f, archive.id);
	await msgIn(f, f.inbox.id, sister);
	await setExp(sister, archive.id, PAST);
	const outside = await msgIn(f, custom.id);
	await setExp(outside, custom.id, PAST);

	const calls = await tick(now);
	const mine = calls.filter((c) => c.data?.mailboxId === archive.id || c.data?.mailboxId === custom.id || c.data?.mailboxId === f.inbox.id);
	assert(mine.length === 1, `un seul job pour l'Archive de la fixture (${mine.length})`);
	const [c] = mine;
	assert(c?.name === "mail:move" && c.data.op === "trash" && c.data.expiry === true && c.data.mailboxId === archive.id, `job mail:move, op trash, expiry, depuis l'Archive (${JSON.stringify(c?.data)})`);
	assert(JSON.stringify(c?.data.threadIds) === JSON.stringify([due]) && c?.data.threadId === due, "seul le fil du part (non du, etoile, ligne Inbox soeur, hors Archive : non)");
	assert(c?.data.moveImap === false, "Archive sans mailbox_sync : moveImap false");
	assert(c?.opts?.jobId === `expire-${archive.id}-${expiryBucket(now)}`, `jobId expire-<dossier>-<heure UTC> (${c?.opts?.jobId})`);
	assert(c?.opts?.attempts === 8 && c?.opts?.backoff?.type === "exponential" && c?.opts?.removeOnComplete === true, "job rejoue en cas d'echec (8 essais, backoff exponentiel)");

	assert((await row(due, archive.id))?.expiresAt?.getTime() === PAST.getTime(), "le tick ne vide pas l'echeance d'un fil du (le move s'en charge)");
	assert((await row(notDue, archive.id))?.expiresAt?.getTime() === FUTURE.getTime(), "fil non du : echeance gardee");
	assert((await row(outside, custom.id))?.expiresAt === null, "ligne a echeance hors Archive : remise a NULL");
	assert((await row(sister, archive.id))?.expiresAt === null, "ligne Archive avec une ligne Inbox soeur : remise a NULL");

	const again = (await tick(now)).filter((x) => x.data?.mailboxId === archive.id);
	assert(again.length === 1 && again[0].opts.jobId === c?.opts?.jobId, "deux executions de suite : meme jobId (BullMQ n'en garde qu'un)");

	// Archive synchronisee en IMAP : le job demande le MOVE IMAP.
	const g = await createUserFixture("expire-tick-sync");
	const archiveSync = await folderOf(g, "archive", "Archive");
	await db.insert(mailboxSync).values({ identityId: g.identity.id, mailboxId: archiveSync.id, uidValidity: BigInt(1), lastSeenUid: 1 });
	const dueSync = await msgIn(g, archiveSync.id);
	await setExp(dueSync, archiveSync.id, PAST);
	const synced = (await tick(now)).filter((x) => x.data?.mailboxId === archiveSync.id);
	assert(synced.length === 1 && synced[0].data.moveImap === true, "Archive synchronisee : moveImap true");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
