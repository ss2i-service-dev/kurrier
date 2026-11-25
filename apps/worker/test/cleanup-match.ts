// Matcher commun du nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT4) :
// matchCleanup (@common, cleanup-match.ts) demande des candidats a un `search` injecte (Typesense strict)
// puis laisse eligibleCleanupThreads (SQL) decider ; countStrictMatches rend le `found` de la meme
// recherche sans date limite. L'index ne decide jamais : un candidat etoile, en Corbeille, actif ou d'une
// autre identite n'est jamais rendu, et la requete est revalidee a chaque appel.
// Base de test : voir mcp-test-env.ts (scripts/test.sh worker apps/worker/test/cleanup-match.ts).
import { readFileSync } from "node:fs";
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxThreads, messages, threads } from "@db";
import { cleanupSearchParams, countStrictMatches, matchCleanup, upsertMailboxThreadItem, type CleanupScope } from "@common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const OLD = ago(100);
const RECENT = ago(2);
const PAGE = 250;

async function folderOf(f: Fixture, kind: "archive" | "trash", name: string) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind,
			name,
			slug: kind,
			isDefault: false,
			metaData: { imap: { path: name } },
		})
		.returning();
	return row;
}

async function msgIn(f: Fixture, mailboxId: string, o: { date: Date; thread?: string }): Promise<string> {
	const threadId =
		o.thread ?? (await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: o.date }).returning())[0].id;
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: `<match-${Math.random().toString(36).slice(2)}@x>`,
			subject: "fil",
			text: "corps",
			date: o.date,
			createdAt: o.date,
			seen: true,
			hasAttachments: false,
			metaData: {},
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return threadId;
}

// Faux Typesense : sert, page par page, la liste de candidats (ids de fils, dans l'ordre) et note chaque
// appel. Une page pleine (250 groupes) signale qu'il y en a d'autres, comme grouped_hits.
function fakeSearch(candidates: string[], found = candidates.length) {
	const calls: any[] = [];
	const search = async (params: any) => {
		calls.push(params);
		const per = Number(params.per_page);
		const start = (Number(params.page) - 1) * per;
		const slice = candidates.slice(start, start + per);
		return {
			found,
			grouped_hits: slice.map((id) => ({ group_key: [id], hits: [{ document: { id: `doc-${id}`, threadId: id } }] })),
		};
	};
	return { search, calls };
}

const unknown = (n: number) => Array.from({ length: n }, () => randomUUID());

async function main() {
	const f = await createUserFixture("cleanup-match");
	const g = await createUserFixture("cleanup-match-other");
	const archive = await folderOf(f, "archive", "Archive");
	const trash = await folderOf(f, "trash", "Trash");

	const scope = (over: Partial<CleanupScope> = {}): CleanupScope => ({
		identityId: f.identity.id,
		identityPublicId: f.identity.publicId,
		workspacePublicId: f.workspace.publicId,
		mailboxIds: [f.inbox.id, archive.id],
		query: "fil",
		hasAttachment: false,
		onlyUnread: false,
		retentionDays: 30,
		...over,
	});
	const run = (s: CleanupScope, candidates: string[], o: { limit?: number; maxPages?: number } = {}) => {
		const fake = fakeSearch(candidates);
		return matchCleanup({ search: fake.search, dbh: db }, s, { now, limit: o.limit ?? 200, maxPages: o.maxPages ?? 40 }).then((r) => ({ ...r, calls: fake.calls }));
	};
	const ids = (r: { rows: { threadId: string }[] }) => [...new Set(r.rows.map((x) => x.threadId))];

	console.log("# requete et portee revalidees : zero appel");
	for (const q of ["", "ab", "*", "-banque", "a b c"]) {
		const fake = fakeSearch([randomUUID()]);
		const r = await matchCleanup({ search: fake.search, dbh: db }, scope({ query: q }), { now, limit: 200, maxPages: 40 });
		assert(r.rows.length === 0 && r.truncated === false && fake.calls.length === 0, `requete ${JSON.stringify(q)} : rien, aucun appel a search`);
		const c = fakeSearch([randomUUID()]);
		assert((await countStrictMatches({ search: c.search }, scope({ query: q }))) === 0 && c.calls.length === 0, `compte de ${JSON.stringify(q)} : 0, aucun appel`);
	}
	const none = fakeSearch([randomUUID()]);
	const noBox = await matchCleanup({ search: none.search, dbh: db }, scope({ mailboxIds: [] }), { now, limit: 200, maxPages: 40 });
	assert(noBox.rows.length === 0 && !noBox.truncated && none.calls.length === 0, "aucun dossier : rien, aucun appel");
	const badBox = await matchCleanup({ search: none.search, dbh: db }, scope({ mailboxIds: ["pas-un-uuid"] }), { now, limit: 200, maxPages: 40 });
	assert(badBox.rows.length === 0 && none.calls.length === 0, "dossier qui n'est pas un UUID : rien, aucun appel");
	assert((await countStrictMatches({ search: none.search }, scope({ mailboxIds: [] }))) === 0 && none.calls.length === 0, "compte sans dossier : 0, aucun appel");

	console.log("# l'index ne decide pas : le SQL ecarte les candidats inegibles");
	const ok = await msgIn(f, f.inbox.id, { date: OLD });
	const okArchive = await msgIn(f, archive.id, { date: OLD });
	const starred = await msgIn(f, f.inbox.id, { date: OLD });
	await db.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, starred), eq(mailboxThreads.mailboxId, f.inbox.id)));
	const trashed = await msgIn(f, trash.id, { date: OLD });
	const active = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, f.inbox.id, { date: RECENT, thread: active });
	const foreign = await msgIn(g, g.inbox.id, { date: OLD });
	const absent = randomUUID();
	let r = await run(scope(), [starred, trashed, active, foreign, absent, "pas-un-uuid", ok, okArchive]);
	assert(
		ids(r).length === 2 && ids(r).includes(ok) && ids(r).includes(okArchive) && r.rows.length === 2 && !r.truncated,
		`seuls les fils eligibles sont rendus (${JSON.stringify(r.rows)})`,
	);
	assert(r.calls.length === 1, "une page de moins de 250 groupes : une seule requete a l'index");
	const call = r.calls[0];
	assert(call.filter_by.includes(`createdAt:<=${new Date(now.getTime() - 30 * DAY).getTime()}`), "le filtre de l'index porte la date limite");
	assert(call.filter_by.includes(f.inbox.id) && call.filter_by.includes(archive.id) && !call.filter_by.includes(trash.id), "le filtre de l'index porte les dossiers du scope, pas la Corbeille");
	assert(call.num_typos === 0 && call.prefix === false && call.drop_tokens_threshold === 0 && call.split_join_tokens === "off", "parametres stricts transmis");
	assert(!("exhaustive_search" in call), "pas d'exhaustive_search");
	const same = cleanupSearchParams(scope(), { cutoff: new Date(now.getTime() - 30 * DAY), page: 1 });
	assert(JSON.stringify(call) === JSON.stringify(same), "parametres identiques a cleanupSearchParams");

	console.log("# des pages entieres de candidats inegibles n'empechent pas d'atteindre les suivants");
	const late1 = await msgIn(f, f.inbox.id, { date: OLD });
	const late2 = await msgIn(f, f.inbox.id, { date: OLD });
	r = await run(scope(), [...unknown(PAGE * 2), late1, late2]);
	assert(ids(r).length === 2 && ids(r).includes(late1) && ids(r).includes(late2) && !r.truncated, "deux pages d'inegibles puis deux fils eligibles : rendus");
	assert(r.calls.length === 3 && r.calls.map((c) => c.page).join() === "1,2,3", `trois pages demandees (${r.calls.map((c) => c.page)})`);

	console.log("# page pleine suivie d'une page vide : fin sans troncature");
	r = await run(scope(), unknown(PAGE));
	assert(r.rows.length === 0 && !r.truncated && r.calls.length === 2, `page pleine puis vide : deux appels, pas tronque (${r.calls.length})`);

	console.log("# maxPages");
	const beyond = await msgIn(f, f.inbox.id, { date: OLD });
	r = await run(scope(), [...unknown(PAGE * 3), beyond], { maxPages: 2 });
	assert(r.calls.length === 2 && r.truncated && r.rows.length === 0, `maxPages 2 : deux appels, tronque, le fil de la page 4 n'est pas lu (${r.calls.length})`);
	r = await run(scope(), [beyond, ...unknown(10)], { maxPages: 1 });
	assert(r.calls.length === 1 && !r.truncated && ids(r).includes(beyond), "maxPages atteint sur une page incomplete : pas tronque");

	console.log("# limit");
	const many: string[] = [];
	for (let i = 0; i < 5; i++) many.push(await msgIn(f, f.inbox.id, { date: new Date(OLD.getTime() + i * 1000) }));
	r = await run(scope({ query: "fil" }), many, { limit: 3 });
	assert(ids(r).length === 3 && r.rows.length === 3 && r.truncated, `limit 3 sur 5 fils : 3 fils, tronque (${ids(r).length})`);
	r = await run(scope(), many, { limit: 5 });
	assert(ids(r).length === 5 && r.truncated, "limit atteinte pile : tronque (il peut en rester)");
	r = await run(scope(), many, { limit: 6 });
	assert(ids(r).length === 5 && !r.truncated, "limit non atteinte : pas tronque");
	// limit compte des fils distincts : un fil present en Inbox et en Archive compte pour un, ses deux lignes sortent.
	const both = await msgIn(f, f.inbox.id, { date: OLD });
	await msgIn(f, archive.id, { date: OLD, thread: both });
	r = await run(scope(), [both, ...many], { limit: 2 });
	assert(ids(r).length === 2 && r.truncated, "limit : compte de fils distincts, pas de lignes");
	r = await run(scope(), [both], { limit: 1 });
	assert(r.rows.length === 2 && ids(r).length === 1, "limit 1 : le fil de deux dossiers rend ses deux lignes");

	console.log("# erreur de l'index : propagee a l'appelant (le tick la journalise)");
	let thrown = false;
	await matchCleanup({ search: async () => { throw new Error("typesense down"); }, dbh: db }, scope(), { now, limit: 200, maxPages: 40 }).catch(() => (thrown = true));
	assert(thrown, "search qui echoue : l'erreur remonte");

	console.log("# countStrictMatches");
	const cf = fakeSearch([randomUUID()], 1234);
	assert((await countStrictMatches({ search: cf.search }, scope())) === 1234, "rend le found de l'index");
	const cp = cf.calls[0];
	assert(cf.calls.length === 1 && cp.per_page === 1 && cp.page === 1, "une seule page de un resultat");
	assert(!cp.filter_by.includes("createdAt"), "sans date limite");
	assert(cp.num_typos === 0 && cp.split_join_tokens === "off" && cp.group_by === "threadId", "memes parametres stricts, fils groupes");
	assert((await countStrictMatches({ search: async () => ({}) }, scope())) === 0, "reponse sans found : 0");

	console.log("# source : aucun client Typesense, tout passe par @common");
	const src = readFileSync(new URL("../../../packages/common/src/cleanup-match.ts", import.meta.url), "utf8");
	assert(!/from\s+["']typesense["']/.test(src) && !/typesense/i.test(src.replace(/\/\/.*$/gm, "")), "cleanup-match.ts n'importe aucun client Typesense");
	assert(/cleanupQueryError\(/.test(src) && /eligibleCleanupThreads\(/.test(src) && /cleanupSearchParams\(/.test(src), "revalide la requete, decide en SQL, parametres de cleanup-rules");
	const index = readFileSync(new URL("../../../packages/common/src/index.ts", import.meta.url), "utf8");
	assert(/export \* from "\.\/cleanup-match"/.test(index), "exporte par l'index de @common");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
