// Nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT6) : le tick mail:cleanup-tick
// parcourt les regles non suspendues dont l'auteur possede toujours l'identite, de la moins
// recemment passee a la plus recente. Pour chacune : loadCleanupRule (portee relue en base), puis
// matchCleanup (Typesense strict, simule ici ; le SQL decide), puis un job mail:move op trash avec
// cleanupRuleId par dossier : 200 fils au plus, jobId stable dans l'heure, priorite 100. 10 jobs au
// plus par tick ; une erreur sur une regle n'arrete pas les autres, sauf une erreur de transport
// Typesense (sans httpStatus) qui arrete le tick. Le tick n'ecrit que
// cleanup_rules.last_run_at, jamais mailbox_threads (moveMail decide et deplace).
// La base de test est partagee : d'autres tests y laissent des regles actives. Le faux Typesense ne
// sert que les identites de ce test, les assertions portent sur nos regles et sur les jobs.
// Base de test : voir mcp-test-env.ts, ou dans le service node de compose.tools.yml :
//   scripts/test.sh worker apps/worker/test/cleanup-tick.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { cleanupRules, db, identities, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { CLEANUP_BATCH, CLEANUP_MAX_JOBS_PER_TICK, CLEANUP_MAX_PAGES, expiryBucket, insertCleanupRule, upsertMailboxThreadItem } from "@common";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runCleanupTick } from "../lib/mail-cleanup";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OLD = new Date(Date.now() - 400 * DAY);
const RECENT = new Date(Date.now() - DAY);
// Toutes les heures du test partent d'un meme debut d'heure : now et later tombent dans la meme
// tranche de jobId, nextHour dans la suivante.
const H0 = Math.floor(Date.now() / HOUR) * HOUR;
const now = new Date(H0 + 60_000);
const later = new Date(H0 + 50 * 60_000);
const nextHour = new Date(H0 + HOUR + 60_000);
const LONG_AGO = new Date("2000-01-01T00:00:00Z");

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

// Un message date `date` dans `mailboxId` (nouveau fil, ou fil `thread`), ligne de fil recalculee.
async function msgIn(f: Fixture, mailboxId: string, o: { date?: Date; thread?: string } = {}): Promise<string> {
	const date = o.date ?? OLD;
	const threadId =
		o.thread ?? (await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: date }).returning())[0].id;
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: `<cleanup-tick-${Math.random().toString(36).slice(2)}@x>`,
			subject: "fil",
			text: "corps",
			date,
			createdAt: date,
			seen: true,
			metaData: {},
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return threadId;
}

async function ruleOf(f: Fixture, query: string, mailboxId: string | null = null) {
	const r = await insertCleanupRule(db, {
		ownerId: f.user.id,
		identityId: f.identity.id,
		mailboxId,
		query,
		hasAttachment: false,
		onlyUnread: false,
		retentionDays: 30,
	});
	if (!r.ok) throw new Error(`regle non creee : ${r.message}`);
	return r.rule.id;
}

const ruleRow = async (id: string) => (await db.select().from(cleanupRules).where(eq(cleanupRules.id, id)))[0];
const setLastRun = (id: string, at: Date | null) => db.update(cleanupRules).set({ lastRunAt: at }).where(eq(cleanupRules.id, id));

// Empreinte de toutes les lignes mailbox_threads des identites du test (toutes colonnes).
async function fingerprint(identityIds: string[]) {
	const [r] = (await db.execute(sql`
		select count(*)::int as n, md5(coalesce(string_agg(mt::text, '|' order by mt.thread_id, mt.mailbox_id), '')) as h
		from mailbox_threads mt where mt.identity_id = any(${`{${identityIds.join(",")}}`}::uuid[])
	`)) as any[];
	return `${r.n}:${r.h}`;
}

// Faux Typesense : par identite (identityPublicId du filtre), les fils a servir dans l'ordre de
// l'index, par pages de per_page groupes ; "throw" : reponse d'erreur de Typesense (httpStatus 503, propre
// a la requete) ; "down" : erreur de transport sans httpStatus (connexion refusee, delai depasse) ;
// "endless" : pages pleines de fils inconnus de la base. Identite absente (regles laissees par d'autres
// tests) : aucun resultat.
const served = new Map<string, string[] | "throw" | "down" | "endless">();
let calls: string[] = [];
async function search(params: any) {
	const pid = /identityPublicId:="([^"]+)"/.exec(String(params?.filter_by ?? ""))?.[1] ?? "";
	calls.push(pid);
	const s = served.get(pid);
	if (s === "throw") throw Object.assign(new Error("typesense en erreur (test)"), { httpStatus: 503 });
	if (s === "down") throw new Error("connect ECONNREFUSED (test)");
	const group = (id: string) => ({ group_key: [id], hits: [{ document: { threadId: id } }] });
	if (s === "endless") return { found: 1_000_000, grouped_hits: Array.from({ length: params.per_page }, () => group(randomUUID())) };
	const ids = s ?? [];
	return { found: ids.length, grouped_hits: ids.slice((params.page - 1) * params.per_page, params.page * params.per_page).map(group) };
}

type Posted = { name: string; data: any; opts: any };
async function tick(at: Date) {
	const posted: Posted[] = [];
	const res = await runCleanupTick({
		now: at,
		search,
		enqueue: async (name, data, opts) => {
			posted.push({ name, data, opts });
			return {};
		},
	});
	return { posted, res };
}
const of = (posted: Posted[], ruleId: string) => posted.filter((p) => p.data?.cleanupRuleId === ruleId);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
	// --- Donnees : toutes les fixtures d'abord, puis l'empreinte de mailbox_threads.
	const A = await createUserFixture("cleanup-tick-a");
	const lettres = await folderOf(A, "custom", "Lettres");
	const archiveA = await folderOf(A, "archive", "Archive");
	await db.insert(mailboxSync).values({ identityId: A.identity.id, mailboxId: lettres.id, uidValidity: BigInt(1), lastSeenUid: 1 });
	const a1 = await msgIn(A, A.inbox.id);
	const a2 = await msgIn(A, lettres.id);
	const a3 = await msgIn(A, A.inbox.id);
	await msgIn(A, archiveA.id, { thread: a3 });
	const a4 = await msgIn(A, A.inbox.id, { date: RECENT });
	const a5 = await msgIn(A, A.inbox.id);
	await db.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, a5), eq(mailboxThreads.mailboxId, A.inbox.id)));
	const a6 = await msgIn(A, A.sent.id);

	const B = await createUserFixture("cleanup-tick-b");
	const archiveB = await folderOf(B, "archive", "Archive");
	const b1 = await msgIn(B, B.inbox.id);
	const b2 = await msgIn(B, archiveB.id);

	const C = await createUserFixture("cleanup-tick-c");
	const c1 = await msgIn(C, C.inbox.id);
	const D = await createUserFixture("cleanup-tick-d");
	const d1 = await msgIn(D, D.inbox.id);
	const E = await createUserFixture("cleanup-tick-e");
	const e1 = await msgIn(E, E.inbox.id);
	const F = await createUserFixture("cleanup-tick-f");
	const fIds: string[] = [];
	for (let i = 0; i < CLEANUP_BATCH + 5; i++) fIds.push(await msgIn(F, F.inbox.id));
	const G = await createUserFixture("cleanup-tick-g");
	const g1 = await msgIn(G, G.inbox.id);
	const K = await createUserFixture("cleanup-tick-k");
	const kIds: string[] = [];
	for (let i = 0; i < CLEANUP_MAX_JOBS_PER_TICK + 1; i++) kIds.push(await msgIn(K, (await folderOf(K, "custom", `Dossier${i}`)).id));
	const L = await createUserFixture("cleanup-tick-l");
	const l1 = await msgIn(L, L.inbox.id);
	const H = await createUserFixture("cleanup-tick-h");
	const I = await createUserFixture("cleanup-tick-i");
	const i1 = await msgIn(I, I.inbox.id);
	const J = await createUserFixture("cleanup-tick-j");
	const M = await createUserFixture("cleanup-tick-m");
	const N = await createUserFixture("cleanup-tick-n");
	const n1 = await msgIn(N, N.inbox.id);

	const all = [A, B, C, D, E, F, G, K, L, H, I, J, M, N].map((f) => f.identity.id);
	const before = await fingerprint(all);

	// --- 1. Jobs postes : un par dossier, donnees et options du contrat, portee relue en base.
	const RA = await ruleOf(A, "facture");
	const RB = await ruleOf(B, "relance", B.inbox.id);
	const RA0 = await ruleRow(RA);
	served.set(A.identity.publicId, [a1, a2, a3, a4, a5, a6]);
	served.set(B.identity.publicId, [b1, b2]);

	const t1 = await tick(now);
	assert(t1.res.jobs === t1.posted.length, "le tick rend le nombre de jobs postes");
	const ja = of(t1.posted, RA);
	const byBox = (box: string) => ja.filter((p) => p.data.mailboxId === box);
	assert(ja.length === 3, `regle tous dossiers : un job par dossier nettoyable qui a des fils dus (3, vu ${ja.length})`);
	// Ordre dans un job : celui du SQL de matchCleanup (age puis id), compare comme un ensemble.
	assert(byBox(A.inbox.id).length === 1 && same([...(byBox(A.inbox.id)[0]?.data.threadIds ?? [])].sort(), [a1, a3].sort()), "Inbox : ses deux fils anciens");
	assert(byBox(lettres.id).length === 1 && same(byBox(lettres.id)[0]?.data.threadIds, [a2]), "dossier personnel : son fil ancien");
	assert(byBox(archiveA.id).length === 1 && same(byBox(archiveA.id)[0]?.data.threadIds, [a3]), "fil present dans deux dossiers : un job dans chacun");
	const moved = ja.flatMap((p) => p.data.threadIds);
	assert(![a4, a5, a6].some((t) => moved.includes(t)), "fil recent, fil etoile et fil d'Envoyes : jamais dans un job");
	assert(byBox(lettres.id)[0]?.data.moveImap === true && byBox(A.inbox.id)[0]?.data.moveImap === false, "moveImap = presence d'une ligne mailbox_sync");
	for (const p of ja) {
		assert(p.name === "mail:move", "job mail:move");
		assert(same(Object.keys(p.data).sort(), ["cleanupRuleId", "mailboxId", "moveImap", "op", "threadId", "threadIds"]), "donnees du job : threadId, threadIds, mailboxId, op, moveImap, cleanupRuleId, rien d'autre");
		assert(p.data.op === "trash" && p.data.cleanupRuleId === RA && p.data.threadId === p.data.threadIds[0], "op trash, cleanupRuleId, threadId = premier fil");
		const text = JSON.stringify(p.data);
		assert(![A.identity.publicId, A.workspace.publicId, "lettres", "inbox", "archive"].some((s) => text.includes(s)), "aucun slug ni publicId dans le job");
		assert(
			same(p.opts, {
				jobId: `cleanup-${RA}-${p.data.mailboxId}-${expiryBucket(now)}`,
				attempts: 8,
				backoff: { type: "exponential", delay: 5000 },
				removeOnComplete: true,
				removeOnFail: { age: 604800 },
				priority: 100,
			}),
			`options du job (jobId deterministe, 8 essais, priorite 100) : ${JSON.stringify(p.opts)}`,
		);
	}
	const jb = of(t1.posted, RB);
	assert(jb.length === 1 && jb[0].data.mailboxId === B.inbox.id && same(jb[0].data.threadIds, [b1]), "regle sur un dossier : ce dossier seulement");

	const RA1 = await ruleRow(RA);
	assert(RA1?.lastRunAt?.getTime() === now.getTime(), "last_run_at = now apres le passage");
	assert(same({ ...RA1, lastRunAt: null }, { ...RA0, lastRunAt: null }), "cleanup_rules : seul last_run_at a change (ni compteur, ni updated_at)");

	const t2 = await tick(later);
	const ids1 = ja.map((p) => p.opts.jobId).sort();
	assert(ids1.length === 3 && same(of(t2.posted, RA).map((p) => p.opts.jobId).sort(), ids1), "deux ticks dans la meme heure : memes jobId (BullMQ n'en garde qu'un)");
	const t3 = await tick(nextHour);
	const ids3 = of(t3.posted, RA).map((p) => p.opts.jobId);
	assert(ids3.length === 3 && ids3.every((id) => id.endsWith(`-${expiryBucket(nextHour)}`) && !ids1.includes(id)), "heure suivante : nouveau jobId");
	served.delete(A.identity.publicId);
	served.delete(B.identity.publicId);

	// --- 2. Regle suspendue, orpheline (identite transferee), requete invalide : aucun job. Temoin :
	//        les memes regles et le meme fil donnaient un job avant la pause et le transfert.
	const RCv = await ruleOf(C, "facture");
	const RCp = await ruleOf(C, "relance");
	const [inv] = await db
		.insert(cleanupRules)
		.values({ ownerId: C.user.id, identityId: C.identity.id, query: "a b c", retentionDays: 30 })
		.returning();
	const RCi = inv.id;
	const RD = await ruleOf(D, "facture");
	served.set(C.identity.publicId, [c1]);
	served.set(D.identity.publicId, [d1]);
	const w = await tick(now);
	assert(of(w.posted, RCv).length === 1 && of(w.posted, RCp).length === 1 && of(w.posted, RD).length === 1, "temoin : avant pause et transfert, chaque regle poste son job");
	assert(of(w.posted, RCi).length === 0, "requete invalide (« a b c ») : aucun job, a cote d'une regle valide sur le meme fil");

	await db.update(cleanupRules).set({ paused: true }).where(eq(cleanupRules.id, RCp));
	await db.update(identities).set({ ownerId: C.user.id }).where(eq(identities.id, D.identity.id));
	calls = [];
	const x = await tick(now);
	assert(of(x.posted, RCv).length === 1, "regle valide de la meme identite : toujours son job");
	assert(of(x.posted, RCp).length === 0, "regle suspendue : aucun job");
	assert(of(x.posted, RD).length === 0, "regle orpheline (identite transferee a un autre proprietaire) : aucun job");
	assert(of(x.posted, RCi).length === 0, "requete invalide : toujours aucun job");
	assert(calls.filter((p) => p === D.identity.publicId).length === 0, "regle orpheline : Typesense jamais interroge");
	assert(calls.filter((p) => p === C.identity.publicId).length === 1, "suspendue et invalide : Typesense interroge pour la seule regle valide");
	served.delete(C.identity.publicId);
	served.delete(D.identity.publicId);

	// --- 3. Fil vise par deux regles : deux jobs, sans erreur.
	const RE1 = await ruleOf(E, "facture");
	const RE2 = await ruleOf(E, "urgent");
	served.set(E.identity.publicId, [e1]);
	const y = await tick(now);
	const j1 = of(y.posted, RE1);
	const j2 = of(y.posted, RE2);
	assert(j1.length === 1 && j2.length === 1 && j1[0].opts.jobId !== j2[0].opts.jobId, "deux regles sur le meme fil : deux jobs, jobId distincts");
	assert(same(j1[0]?.data.threadIds, [e1]) && same(j2[0]?.data.threadIds, [e1]), "chacun avec le fil");
	served.delete(E.identity.publicId);

	// --- 4. 200 fils au plus par (regle, dossier).
	const RF = await ruleOf(F, "facture");
	served.set(F.identity.publicId, fIds);
	const z = await tick(now);
	const jf = of(z.posted, RF);
	assert(jf.length === 1 && jf[0].data.threadIds.length === CLEANUP_BATCH, `205 fils dus : un job de ${CLEANUP_BATCH} fils (vu ${jf[0]?.data.threadIds.length})`);
	const fj: string[] = jf[0]?.data.threadIds ?? [];
	assert(new Set(fj).size === CLEANUP_BATCH && fj.every((t) => fIds.includes(t)), "200 fils distincts, tous parmi les fils dus");
	served.delete(F.identity.publicId);

	// --- 5. 12 regles avec des fils dus : 10 jobs au premier tick, les 2 restantes en tete du suivant.
	const RG: string[] = [];
	for (let i = 1; i <= 12; i++) RG.push(await ruleOf(G, `sujet${String(i).padStart(2, "0")}`, G.inbox.id));
	served.set(G.identity.publicId, [g1]);
	const g = await tick(now);
	const first = g.posted.map((p) => p.data.cleanupRuleId);
	assert(g.posted.length === CLEANUP_MAX_JOBS_PER_TICK && g.res.jobs === CLEANUP_MAX_JOBS_PER_TICK, `premier tick : ${CLEANUP_MAX_JOBS_PER_TICK} jobs (vu ${g.posted.length})`);
	assert(new Set(first).size === CLEANUP_MAX_JOBS_PER_TICK && first.every((id) => RG.includes(id)), "un job par regle, 10 regles differentes");
	const rest = RG.filter((id) => !first.includes(id));
	assert(rest.length === 2, "2 regles non traitees");
	assert((await Promise.all(rest.map(ruleRow))).every((r) => r?.lastRunAt === null), "regles non atteintes : last_run_at intact");
	const g2 = await tick(now);
	assert(same(g2.posted.slice(0, 2).map((p) => p.data.cleanupRuleId).sort(), [...rest].sort()), "tick suivant : les 2 regles restantes passent en tete");
	served.delete(G.identity.publicId);

	// --- 6. Plafond atteint au milieu d'une regle (11 dossiers dus) : 10 jobs, la regle passe quand
	//        meme en fin de rotation, une autre regle est servie au tick suivant (pas de famine).
	const RK = await ruleOf(K, "facture");
	const RL = await ruleOf(L, "facture");
	await setLastRun(RL, LONG_AGO);
	served.set(K.identity.publicId, kIds);
	served.set(L.identity.publicId, [l1]);
	const k = await tick(now);
	assert(k.posted.length === CLEANUP_MAX_JOBS_PER_TICK && of(k.posted, RK).length === CLEANUP_MAX_JOBS_PER_TICK, `regle a 11 dossiers dus : ${CLEANUP_MAX_JOBS_PER_TICK} jobs, pas un de plus`);
	assert(of(k.posted, RL).length === 0, "l'autre regle attend le tick suivant");
	assert((await ruleRow(RK))?.lastRunAt?.getTime() === now.getTime(), "regle coupee par le plafond : last_run_at pose (fin de rotation)");
	const k2 = await tick(now);
	assert(k2.posted[0]?.data.cleanupRuleId === RL, "tick suivant : l'autre regle passe en premier");
	served.delete(K.identity.publicId);
	served.delete(L.identity.publicId);

	// --- 7. Typesense indisponible pour une regle, pages pleines pour une autre : journalise, les
	//        autres regles passent ; 40 pages au plus ; le texte cherche n'est pas journalise.
	const RH = await ruleOf(H, "facture");
	const RJ = await ruleOf(J, "confidentiel");
	const RI = await ruleOf(I, "facture");
	await setLastRun(RI, LONG_AGO); // apres RH et RJ (jamais passees)
	served.set(H.identity.publicId, "throw");
	served.set(J.identity.publicId, "endless");
	served.set(I.identity.publicId, [i1]);
	const logs: string[] = [];
	const { error, warn } = console;
	console.error = (...a: any[]) => {
		logs.push(a.map(String).join(" "));
		error(...a);
	};
	console.warn = (...a: any[]) => {
		logs.push(a.map(String).join(" "));
		warn(...a);
	};
	calls = [];
	let e: { posted: Posted[] } | null = null;
	try {
		e = await tick(now);
	} catch (err) {
		error("tick en erreur", err);
	} finally {
		console.error = error;
		console.warn = warn;
	}
	assert(!!e, "une regle en erreur ne fait pas echouer le tick");
	assert(!!e && of(e.posted, RI).length === 1 && of(e.posted, RH).length === 0 && of(e.posted, RJ).length === 0, "Typesense en erreur sur une regle : les suivantes postent leurs jobs");
	assert(logs.some((l) => l.includes(RH)), "erreur journalisee avec l'identifiant de la regle");
	assert((await ruleRow(RH))?.lastRunAt === null, "regle en erreur : last_run_at intact (repassera en tete)");
	assert(calls.filter((p) => p === J.identity.publicId).length === CLEANUP_MAX_PAGES, `pages pleines de candidats ineligibles : ${CLEANUP_MAX_PAGES} pages au plus`);
	assert(logs.some((l) => l.includes(RJ)), "plafond de pages atteint : avertissement avec l'identifiant de la regle");
	assert(
		logs.some((l) => l.includes(RJ) && l.includes("non examines") && l.includes("n'avance pas") && !l.includes("la suite au prochain passage")),
		"avertissement : fils suivants non examines, la regle n'avance pas (matchCleanup repart de la page 1)",
	);
	assert(!logs.some((l) => l.includes("confidentiel")), "le texte cherche n'est jamais journalise");
	assert((await ruleRow(RJ))?.lastRunAt?.getTime() === now.getTime(), "regle sans fil eligible : passee quand meme");
	served.delete(H.identity.publicId);
	served.delete(J.identity.publicId);
	served.delete(I.identity.publicId);

	// --- 8. Erreur de transport (sans httpStatus : Typesense injoignable) : le tick s'arrete, les regles
	//        suivantes n'attendent pas chacune leur delai. Une erreur de Typesense avec httpStatus (section 7)
	//        ne concerne que sa regle. La regle en erreur garde son rang, la suivante passe au tick d'apres.
	const RM = await ruleOf(M, "facture");
	const RN = await ruleOf(N, "facture");
	await setLastRun(RN, LONG_AGO); // apres RM (jamais passee)
	served.set(M.identity.publicId, "down");
	served.set(N.identity.publicId, [n1]);
	logs.length = 0;
	console.error = (...a: any[]) => {
		logs.push(a.map(String).join(" "));
		error(...a);
	};
	calls = [];
	let dn: { posted: Posted[] } | null = null;
	try {
		dn = await tick(now);
	} finally {
		console.error = error;
	}
	assert(!!dn && of(dn.posted, RN).length === 0, "Typesense injoignable : la regle suivante n'est pas traitee dans ce tick");
	assert(calls.filter((p) => p === N.identity.publicId).length === 0, "Typesense injoignable : aucune requete pour les regles suivantes");
	assert(logs.some((l) => l.includes(RM)), "erreur de transport journalisee avec l'identifiant de la regle");
	assert((await ruleRow(RM))?.lastRunAt === null && (await ruleRow(RN))?.lastRunAt?.getTime() === LONG_AGO.getTime(), "last_run_at intact pour les deux regles");
	served.delete(M.identity.publicId);
	const up = await tick(now);
	assert(of(up.posted, RN).length === 1 && same(of(up.posted, RN)[0].data.threadIds, [n1]), "Typesense revenu : la regle suivante poste son job");
	served.delete(N.identity.publicId);

	// --- Rien n'a ete ecrit sur mailbox_threads (aucun expires_at, aucune ligne deplacee).
	assert((await fingerprint(all)) === before, "mailbox_threads strictement inchange apres tous les ticks");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
