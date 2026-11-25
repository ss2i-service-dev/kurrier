// Eligibilite au nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT3) :
// eligibleCleanupThreads (@common, cleanup-eligible.ts) rend les lignes mailbox_threads du scope dont le
// fil est vieux (son message le plus recent, tous dossiers confondus, Envoyes et Brouillons compris, a
// la date limite ou avant), non etoile et non reporte. Sous forUpdate, l'etoile et l'age de la ligne
// verrouillee sont relus apres l'attente du verrou (READ COMMITTED).
// Base de test : voir mcp-test-env.ts (scripts/test.sh worker apps/worker/test/cleanup-eligible.ts).
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxThreads, messages, threads } from "@db";
import { eligibleCleanupThreads, upsertMailboxThreadItem, type CleanupRow, type CleanupScope } from "@common";
import { and, eq, sql } from "drizzle-orm";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const OLD = ago(100);
const OLDER = ago(200);
const RECENT = ago(2);

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

// Un fil d'un message dans `mailboxId`, ou un message de plus dans le fil `thread`. date et createdAt
// valent la meme chose par defaut, comme a la reception (parseAndStoreEmail).
async function msgIn(
	f: Fixture,
	mailboxId: string,
	o: { date: Date; createdAt?: Date; thread?: string; seen?: boolean; attach?: boolean },
): Promise<string> {
	const threadId =
		o.thread ?? (await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: o.date }).returning())[0].id;
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: `<cleanup-${Math.random().toString(36).slice(2)}@x>`,
			subject: "fil",
			text: "corps",
			date: o.date,
			createdAt: o.createdAt ?? o.date,
			seen: o.seen ?? true,
			hasAttachments: o.attach ?? false,
			metaData: {},
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return threadId;
}

const setRow = (threadId: string, mailboxId: string, values: Partial<typeof mailboxThreads.$inferInsert>) =>
	db
		.update(mailboxThreads)
		.set(values)
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));

const rowOf = async (threadId: string, mailboxId: string) =>
	(await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId))))[0];

const has = (rows: CleanupRow[], threadId: string, mailboxId: string) => rows.some((r) => r.threadId === threadId && r.mailboxId === mailboxId);
const ofThread = (rows: CleanupRow[], threadId: string) => rows.filter((r) => r.threadId === threadId);

async function main() {
	const f = await createUserFixture("cleanup-eligible");
	const g = await createUserFixture("cleanup-eligible-other");
	const archive = await folderOf(f, "archive", "Archive");
	const custom = await folderOf(f, "custom", "Projets");

	const scope = (over: Partial<CleanupScope> = {}): CleanupScope => ({
		identityId: f.identity.id,
		identityPublicId: f.identity.publicId,
		workspacePublicId: f.workspace.publicId,
		mailboxIds: [f.inbox.id, archive.id, custom.id],
		query: "fil",
		hasAttachment: false,
		onlyUnread: false,
		retentionDays: 30,
		...over,
	});
	const elig = (s: CleanupScope, threadIds: string[], extra: { mailboxId?: string } = {}) =>
		eligibleCleanupThreads(db, s, { now, threadIds, ...extra });

	console.log("# age du fil : message le plus recent, tous dossiers");
	const oldInbox = await msgIn(f, f.inbox.id, { date: OLD });
	let rows = await elig(scope(), [oldInbox]);
	assert(rows.length === 1 && has(rows, oldInbox, f.inbox.id) && rows[0].expiresAt === null, `fil ancien en Inbox : eligible (${JSON.stringify(rows)})`);

	const activeSame = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, f.inbox.id, { date: RECENT, thread: activeSame });
	assert(!(await elig(scope(), [activeSame])).length, "message recent dans le meme dossier : non");

	const sentSister = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, f.sent.id, { date: RECENT, thread: sentSister });
	assert(!(await elig(scope(), [sentSister])).length, "reponse recente en Envoyes : non");

	const draftSister = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, f.drafts.id, { date: RECENT, thread: draftSister });
	assert((await rowOf(draftSister, f.inbox.id))?.lastActivityAt.getTime() === OLD.getTime(), "precondition : un brouillon ne remonte pas la ligne Inbox");
	assert(!(await elig(scope(), [draftSister])).length, "brouillon recent en Brouillons (ligne soeur) : non");

	// Ligne soeur recente sans message recent (last_activity_at seul, ex. GREATEST apres un depart).
	const sisterRow = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, archive.id, { date: OLD, thread: sisterRow });
	await setRow(sisterRow, archive.id, { lastActivityAt: RECENT });
	assert(!(await elig(scope(), [sisterRow])).length, "ligne soeur Archive recente (last_activity_at seul) : aucune ligne du fil");

	// Message date ancien mais cree recemment en base : la reception ne produit jamais cette ligne
	// (date = created_at, date interne IMAP d'abord), seulement un brouillon ou une copie d'envoi.
	// Ce cas prouve la clause max(date, created_at) sur les messages, pas une garde contre un en-tete
	// Date antidate.
	const lateRow = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, f.drafts.id, { date: OLD, createdAt: RECENT, thread: lateRow });
	assert(
		(await rowOf(lateRow, f.drafts.id))?.lastActivityAt.getTime() === OLD.getTime() && (await rowOf(lateRow, f.inbox.id))?.lastActivityAt.getTime() === OLD.getTime(),
		"precondition : toutes les lignes du fil ont un last_activity_at ancien",
	);
	assert(!(await elig(scope(), [lateRow])).length, "message du fil avec date ancienne et created_at recent : non (max des deux dates)");

	console.log("# etoile et report");
	const starredRow = await msgIn(f, f.inbox.id, { date: OLD });
	await setRow(starredRow, f.inbox.id, { starred: true });
	assert(!(await elig(scope(), [starredRow])).length, "ligne etoilee : non");

	const starredSister = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, archive.id, { date: OLD, thread: starredSister });
	await setRow(starredSister, archive.id, { starred: true });
	assert(!(await elig(scope(), [starredSister])).length, "ligne soeur etoilee : aucune ligne du fil");

	const snoozed = await msgIn(f, f.inbox.id, { date: OLD });
	await setRow(snoozed, f.inbox.id, { snoozedUntil: new Date(now.getTime() + DAY) });
	assert(!(await elig(scope(), [snoozed])).length, "report dans le futur : non");
	const snoozeOver = await msgIn(f, f.inbox.id, { date: OLD });
	await setRow(snoozeOver, f.inbox.id, { snoozedUntil: new Date(now.getTime() - DAY) });
	assert(has(await elig(scope(), [snoozeOver]), snoozeOver, f.inbox.id), "report echu : eligible");
	const snoozedSister = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, custom.id, { date: OLD, thread: snoozedSister });
	await setRow(snoozedSister, custom.id, { snoozedUntil: new Date(now.getTime() + DAY) });
	assert(!(await elig(scope(), [snoozedSister])).length, "ligne soeur reportee dans le futur : aucune ligne du fil");

	console.log("# filtres de la regle");
	const readOld = await msgIn(f, f.inbox.id, { date: OLD, seen: true });
	const unreadOld = await msgIn(f, f.inbox.id, { date: OLD, seen: false });
	rows = await elig(scope({ onlyUnread: true }), [readOld, unreadOld]);
	assert(!ofThread(rows, readOld).length && has(rows, unreadOld, f.inbox.id), "onlyUnread : fil lu exclu, fil non lu rendu");
	assert((await elig(scope(), [readOld, unreadOld])).length === 2, "sans onlyUnread : les deux");
	const withAttach = await msgIn(f, f.inbox.id, { date: OLD, attach: true });
	rows = await elig(scope({ hasAttachment: true }), [readOld, withAttach]);
	assert(!ofThread(rows, readOld).length && has(rows, withAttach, f.inbox.id), "hasAttachment : seul le fil avec piece jointe");

	console.log("# portee");
	const both = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, archive.id, { date: OLD, thread: both });
	rows = await elig(scope(), [both]);
	assert(rows.length === 2 && has(rows, both, f.inbox.id) && has(rows, both, archive.id), "tous les dossiers : lignes Inbox et Archive rendues");
	rows = await elig(scope(), [both], { mailboxId: archive.id });
	assert(rows.length === 1 && has(rows, both, archive.id), "mailboxId : la ligne de ce dossier seulement");
	assert(!(await elig(scope({ mailboxIds: [f.inbox.id] }), [both], { mailboxId: archive.id })).length, "mailboxId hors scope.mailboxIds : rien");

	const inCustom = await msgIn(f, custom.id, { date: OLD });
	assert(!(await elig(scope({ mailboxIds: [f.inbox.id, archive.id] }), [inCustom])).length, "dossier hors scope.mailboxIds : jamais rendu");
	const inSent = await msgIn(f, f.sent.id, { date: OLD });
	assert(!(await elig(scope({ mailboxIds: [f.sent.id, f.drafts.id] }), [inSent])).length, "scope force avec Envoyes : jamais rendu (allow-list relue en base)");

	const foreign = await msgIn(g, g.inbox.id, { date: OLD });
	assert(!(await elig(scope({ mailboxIds: [f.inbox.id, g.inbox.id] }), [foreign])).length, "fil d'une autre identite, dossier glisse dans le scope : jamais rendu");
	assert(
		has(await elig(scope({ identityId: g.identity.id, mailboxIds: [g.inbox.id] }), [foreign]), foreign, g.inbox.id),
		"le meme fil dans le scope de son identite : eligible",
	);

	console.log("# entrees vides ou invalides, ordre");
	let calls = 0;
	const counting = { execute: async () => (calls++, []) };
	assert((await eligibleCleanupThreads(counting, scope(), { now, threadIds: [] })).length === 0 && calls === 0, "threadIds vide : [] sans requete");
	assert((await eligibleCleanupThreads(counting, scope({ mailboxIds: [] }), { now, threadIds: [oldInbox] })).length === 0 && calls === 0, "aucun dossier : [] sans requete");
	rows = await elig(scope(), ["pas-un-uuid", oldInbox]);
	assert(rows.length === 1 && has(rows, oldInbox, f.inbox.id), "identifiant invalide ignore, sans erreur SQL");
	const older = await msgIn(f, f.inbox.id, { date: OLDER });
	rows = await elig(scope(), [oldInbox, older], { mailboxId: f.inbox.id });
	assert(rows.map((r) => r.threadId).join() === [older, oldInbox].join(), "ordre : le plus ancien d'abord");

	console.log("# forUpdate : etoile et activite posees pendant l'attente du verrou");
	const starLate = await msgIn(f, f.inbox.id, { date: OLD });
	const bumpLate = await msgIn(f, f.inbox.id, { date: OLD });
	const control = await msgIn(f, f.inbox.id, { date: OLD });
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let holding!: () => void;
	const held = new Promise<void>((r) => (holding = r));
	const writer = db.transaction(async (tx) => {
		await tx.execute(sql`update mailbox_threads set starred = true where thread_id = ${starLate}::uuid and mailbox_id = ${f.inbox.id}::uuid`);
		await tx.execute(sql`update mailbox_threads set last_activity_at = now() where thread_id = ${bumpLate}::uuid and mailbox_id = ${f.inbox.id}::uuid`);
		holding();
		await gate;
	});
	try {
		await held;
		const reader = db.transaction((tx) => eligibleCleanupThreads(tx, scope(), { now, threadIds: [starLate, bumpLate, control], mailboxId: f.inbox.id, forUpdate: true }));
		let waiting = false;
		for (let i = 0; i < 100 && !waiting; i++) {
			const [w] = (await db.execute(sql`
				select count(*)::int as n from pg_stat_activity
				where wait_event_type = 'Lock' and query ilike '%for update of mt%'
			`)) as any[];
			waiting = Number(w?.n) > 0;
			if (!waiting) await new Promise((r) => setTimeout(r, 50));
		}
		assert(waiting, "la lecture forUpdate attend le verrou de la ligne");
		release();
		await writer;
		rows = await reader;
		assert(
			rows.length === 1 && has(rows, control, f.inbox.id),
			`apres le verrou : etoile et activite relues sur la ligne, seul le fil temoin reste (${JSON.stringify(rows.map((r) => r.threadId === control ? "control" : r.threadId === starLate ? "starLate" : "bumpLate"))})`,
		);
	} finally {
		release();
		await writer.catch(() => {});
	}
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
