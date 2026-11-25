// Nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT5) : moveMail lit cleanupRuleId
// avec les gardes du job expiry. Au debut : op trash seulement, regle existante, non suspendue, dont
// l'identite appartient toujours a son auteur, dossier source dans sa portee, fils encore eligibles
// (eligibleCleanupThreads), fil entier (messageIds ignore). Dans la transaction : regle verrouillee
// (for share) et relue, eligibilite reverifiee sous verrou ; un changement pendant l'attente (etoile,
// pause, duree) annule et rejoue le job. Garde \Flagged avant le MOVE IMAP, echeance Archive remise si
// le serveur refuse, compteur de la regle augmente des fils reellement partis.
// Base de test : voir mcp-test-env.ts, ou dans le service node de compose.tools.yml :
//   scripts/test.sh worker apps/worker/test/cleanup-move.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { cleanupRules, db, identities, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { insertCleanupRule, upsertMailboxThreadItem } from "@common";
import { and, eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import type { ImapFlow } from "imapflow";
import { moveMail } from "../lib/imap/imap-move";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;

const DAY = 86_400_000;
const OLD = new Date(Date.now() - 400 * DAY);
const RECENT = new Date(Date.now() - DAY);
const X = new Date(Date.now() + 30 * DAY);

async function folderOf(f: Fixture, kind: "archive" | "custom" | "trash", name: string) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind,
			name,
			slug: kind === "custom" ? name.toLowerCase() : kind,
			isDefault: kind === "trash",
			metaData: { imap: { path: name } },
		})
		.returning();
	return row;
}

// Un message dans `mailboxId` (nouveau fil, ou fil `thread`), ligne de fil du dossier recalculee.
async function msgIn(
	f: Fixture,
	mailboxId: string,
	o: { date?: Date; thread?: string; uid?: number; path?: string } = {},
): Promise<{ threadId: string; id: string; mid: string }> {
	const date = o.date ?? OLD;
	const threadId =
		o.thread ?? (await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: date }).returning())[0].id;
	const mid = `<cleanup-move-${Math.random().toString(36).slice(2)}@x>`;
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: mid,
			subject: "fil",
			text: "corps",
			date,
			createdAt: date,
			seen: true,
			metaData: o.uid ? { imap: { uid: o.uid, mailboxPath: o.path ?? "INBOX" } } : {},
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return { threadId, id: m.id, mid };
}

const threadRow = async (threadId: string, mailboxId: string) =>
	(await db.select().from(mailboxThreads).where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId))))[0];

const setRow = (threadId: string, mailboxId: string, values: Partial<typeof mailboxThreads.$inferInsert>) =>
	db
		.update(mailboxThreads)
		.set(values)
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));

const boxesOf = async (threadId: string) =>
	(await db.select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.threadId, threadId))).map((r) => r.mailboxId);

// Fil parti en entier : tous ses messages en Corbeille, plus de ligne dans la source.
const gone = async (threadId: string, from: string, trash: string) =>
	(await boxesOf(threadId)).every((b) => b === trash) && !!(await threadRow(threadId, trash)) && !(await threadRow(threadId, from));

// Fil reste en place : aucun message en Corbeille, ligne source presente.
const stays = async (threadId: string, from: string, trash: string) =>
	!(await boxesOf(threadId)).includes(trash) && !!(await threadRow(threadId, from)) && !(await threadRow(threadId, trash));

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
	return r.rule;
}

const counterOf = async (ruleId: string) => {
	const [r] = await db.select().from(cleanupRules).where(eq(cleanupRules.id, ruleId));
	return { n: r?.trashedCount ?? -1, at: r?.lastTrashedAt ?? null };
};

const job = (ruleId: string, threadIds: string[], mailboxId: string, moveImap = false) => ({
	threadId: threadIds[0],
	threadIds,
	mailboxId,
	op: "trash" as const,
	moveImap,
	cleanupRuleId: ruleId,
});

// Attend qu'une session de la base soit bloquee sur un verrou (modele : move-imap.ts, 15 k).
async function waitsOnLock() {
	for (let i = 0; i < 100; i++) {
		const [w] = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
		if (Number((w as any)?.n) > 0) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

// Transaction ouverte qui tient un verrou de ligne jusqu'a release().
async function holding(write: (tx: any) => Promise<unknown>) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let held!: () => void;
	const ready = new Promise<void>((r) => (held = r));
	const done = db.transaction(async (tx) => {
		await write(tx);
		held();
		await gate;
	});
	await ready;
	return { release, done };
}

// Serveur IMAP factice reduit (modele : FakeStalwart de move-imap.ts) : UID MOVE, drapeaux \Flagged
// poses depuis un autre client, MOVE refuse (false sans erreur, comme imapflow).
class FakeImap {
	authenticated = true;
	usable = true;
	refuseMove = false;
	flagged = new Set<string>();
	moves = 0;
	selected = "";
	capabilities = new Map<string, boolean>();
	folders = new Map<string, { uidNext: number; msgs: Map<number, string> }>();
	constructor(init: Record<string, Array<[number, string]>>) {
		for (const [p, msgs] of Object.entries(init)) {
			this.folders.set(p, { uidNext: Math.max(0, ...msgs.map(([u]) => u)) + 1, msgs: new Map(msgs) });
		}
	}
	get mailbox() {
		const f = this.folders.get(this.selected);
		return f ? { path: this.selected, exists: f.msgs.size, uidNext: f.uidNext } : false;
	}
	async getMailboxLock(path: string) {
		if (!this.folders.has(path)) throw new Error(`no folder ${path}`);
		this.selected = path;
		return { path, release() {} };
	}
	async mailboxOpen(path: string) {
		this.selected = path;
		return this.mailbox;
	}
	async status(path: string) {
		return { path, uidNext: this.folders.get(path)!.uidNext };
	}
	async search() {
		return [];
	}
	async *fetch(range: string) {
		const f = this.folders.get(this.selected)!;
		const all = [...f.msgs.keys()].sort((a, b) => a - b);
		const pick = range.endsWith(":*")
			? all.filter((u) => u >= Number(range.split(":")[0]))
			: range.split(",").map(Number).filter((u) => f.msgs.has(u));
		for (const uid of pick) {
			const mid = f.msgs.get(uid)!;
			yield { uid, envelope: { messageId: mid }, flags: new Set(this.flagged.has(mid) ? ["\\Seen", "\\Flagged"] : ["\\Seen"]) };
		}
	}
	async messageMove(uids: number[], dest: string) {
		this.moves++;
		if (this.refuseMove) return false;
		const s = this.folders.get(this.selected)!;
		const d = this.folders.get(dest)!;
		const uidMap = new Map<number, number>();
		for (const u of uids) {
			if (!s.msgs.has(u)) continue;
			const nu = d.uidNext++;
			d.msgs.set(nu, s.msgs.get(u)!);
			s.msgs.delete(u);
			uidMap.set(u, nu);
		}
		return { path: this.selected, destination: dest, uidMap };
	}
}

async function main() {
	const f = await createUserFixture("cleanup-move");
	const archive = await folderOf(f, "archive", "Archive");
	const custom = await folderOf(f, "custom", "Projets");
	const trash = await folderOf(f, "trash", "Deleted Items");
	const rule = await ruleOf(f, "fil");

	console.log("# fil ancien : en Corbeille, echeance nulle a l'arrivee, compteur de la regle");
	const a1 = await msgIn(f, f.inbox.id);
	await moveMail(job(rule.id, [a1.threadId], f.inbox.id), new Map());
	assert(await gone(a1.threadId, f.inbox.id, trash.id), "fil ancien en Inbox : en Corbeille");
	let c = await counterOf(rule.id);
	assert(c.n === 1 && !!c.at, `compteur a 1, last_trashed_at pose (${c.n}, ${c.at})`);

	const a2 = await msgIn(f, archive.id);
	await setRow(a2.threadId, archive.id, { expiresAt: X });
	await moveMail(job(rule.id, [a2.threadId], archive.id), new Map());
	const a2t = await threadRow(a2.threadId, trash.id);
	assert((await gone(a2.threadId, archive.id, trash.id)) && a2t?.expiresAt === null, `fil ancien en Archive avec echeance : en Corbeille, echeance nulle (${a2t?.expiresAt})`);
	assert((await counterOf(rule.id)).n === 2, "compteur a 2");

	console.log("# regle suspendue, supprimee, ou identite transferee entre le tick et le job : rien ne bouge");
	const b1 = await msgIn(f, f.inbox.id);
	await db.update(cleanupRules).set({ paused: true }).where(eq(cleanupRules.id, rule.id));
	await moveMail(job(rule.id, [b1.threadId], f.inbox.id), new Map());
	assert(await stays(b1.threadId, f.inbox.id, trash.id), "regle suspendue : le fil reste");
	assert((await counterOf(rule.id)).n === 2, "regle suspendue : compteur inchange");
	await db.update(cleanupRules).set({ paused: false }).where(eq(cleanupRules.id, rule.id));

	const dropped = await ruleOf(f, "regle supprimee");
	await db.delete(cleanupRules).where(eq(cleanupRules.id, dropped.id));
	await moveMail(job(dropped.id, [b1.threadId], f.inbox.id), new Map());
	assert(await stays(b1.threadId, f.inbox.id, trash.id), "regle supprimee : le fil reste");

	await moveMail(job("pas-un-uuid", [b1.threadId], f.inbox.id), new Map());
	await moveMail({ ...job("", [b1.threadId], f.inbox.id) }, new Map());
	assert(await stays(b1.threadId, f.inbox.id, trash.id), "cleanupRuleId invalide ou vide : le fil reste (jamais une Corbeille ordinaire)");

	{
		const o = await createUserFixture("cleanup-move-owner");
		const n = await createUserFixture("cleanup-move-owner-new");
		const oTrash = await folderOf(o, "trash", "Deleted Items");
		const oRule = await ruleOf(o, "fil");
		const t = await msgIn(o, o.inbox.id);
		await db.update(identities).set({ ownerId: n.user.id }).where(eq(identities.id, o.identity.id));
		await moveMail(job(oRule.id, [t.threadId], o.inbox.id), new Map());
		assert(await stays(t.threadId, o.inbox.id, oTrash.id), "identite transferee a un autre proprietaire : la regle de l'ancien ne s'execute plus");
	}

	console.log("# fil etoile ou reactive apres le tick : reste, les autres partent ; messageIds ignore");
	const s1 = await msgIn(f, f.inbox.id);
	await setRow(s1.threadId, f.inbox.id, { starred: true });
	const s2 = await msgIn(f, f.inbox.id);
	await msgIn(f, f.inbox.id, { date: RECENT, thread: s2.threadId });
	const s3 = await msgIn(f, f.inbox.id);
	const before = (await counterOf(rule.id)).n;
	await moveMail(job(rule.id, [s1.threadId, s2.threadId, s3.threadId], f.inbox.id), new Map());
	assert(await stays(s1.threadId, f.inbox.id, trash.id), "fil etoile apres le tick : reste");
	assert(await stays(s2.threadId, f.inbox.id, trash.id), "fil reactive (message recent) apres le tick : reste");
	assert(await gone(s3.threadId, f.inbox.id, trash.id), "l'autre fil du lot part");
	assert((await counterOf(rule.id)).n === before + 1, "compteur augmente du seul fil parti");

	const m1 = await msgIn(f, f.inbox.id);
	await msgIn(f, f.inbox.id, { thread: m1.threadId });
	await moveMail({ ...job(rule.id, [m1.threadId], f.inbox.id), messageIds: [m1.id] }, new Map());
	assert(await gone(m1.threadId, f.inbox.id, trash.id), "messageIds ignore : le fil entier part");

	console.log("# op autre que trash, dossier hors portee");
	const o1 = await msgIn(f, f.inbox.id);
	await moveMail({ ...job(rule.id, [o1.threadId], f.inbox.id), op: "archive" }, new Map());
	assert((await boxesOf(o1.threadId)).every((b) => b === f.inbox.id) && !(await threadRow(o1.threadId, archive.id)), "cleanupRuleId avec op archive : rien ne bouge");

	const onCustom = await ruleOf(f, "fil", custom.id);
	await moveMail(job(onCustom.id, [o1.threadId], f.inbox.id), new Map());
	assert(await stays(o1.threadId, f.inbox.id, trash.id), "regle sur Projets, job sur l'Inbox : rien ne bouge");
	const sent1 = await msgIn(f, f.sent.id);
	await moveMail(job(rule.id, [sent1.threadId], f.sent.id), new Map());
	assert(await stays(sent1.threadId, f.sent.id, trash.id), "dossier Envoyes (hors allow-list) : rien ne bouge");
	const p1 = await msgIn(f, custom.id);
	await moveMail(job(onCustom.id, [p1.threadId], custom.id), new Map());
	assert((await gone(p1.threadId, custom.id, trash.id)) && (await counterOf(onCustom.id)).n === 1, "regle sur Projets, fil ancien de Projets : en Corbeille, compteur de cette regle a 1");

	console.log("# fil deja present en Corbeille : fusion sans erreur");
	const k1 = await msgIn(f, f.inbox.id);
	await msgIn(f, trash.id, { thread: k1.threadId });
	const beforeClash = (await counterOf(rule.id)).n;
	await moveMail(job(rule.id, [k1.threadId], f.inbox.id), new Map());
	const k1t = await threadRow(k1.threadId, trash.id);
	assert((await gone(k1.threadId, f.inbox.id, trash.id)) && k1t?.messageCount === 2, `collision en Corbeille : ligne fusionnee (${k1t?.messageCount})`);
	assert((await counterOf(rule.id)).n === beforeClash + 1, "collision : le fil compte");

	console.log("# fil present en Inbox et en Archive : compte une fois ; deux jobs concurrents, collision rejouee");
	{
		const d = await msgIn(f, f.inbox.id);
		await msgIn(f, archive.id, { thread: d.threadId });
		const n0 = (await counterOf(rule.id)).n;
		await moveMail(job(rule.id, [d.threadId], f.inbox.id), new Map());
		assert((await counterOf(rule.id)).n === n0, "job Inbox : le fil a encore un message en Archive, pas compte");
		await moveMail(job(rule.id, [d.threadId], archive.id), new Map());
		assert((await gone(d.threadId, archive.id, trash.id)) && !(await threadRow(d.threadId, f.inbox.id)), "job Archive : fil entier en Corbeille");
		assert((await counterOf(rule.id)).n === n0 + 1, `fil de deux dossiers : compte une fois (${(await counterOf(rule.id)).n - n0})`);
	}
	{
		// Le job Inbox d'un autre worker (simule) a deja ecrit la ligne Corbeille du fil, pas encore
		// commitee : le job Archive passe par plain et attend la cle (thread_id, mailbox_id), puis 23505.
		const u = await msgIn(f, f.inbox.id);
		await msgIn(f, archive.id, { thread: u.threadId });
		const n0 = (await counterOf(rule.id)).n;
		const h = await holding(async (tx) => {
			await tx.update(messages).set({ mailboxId: trash.id }).where(and(eq(messages.threadId, u.threadId), eq(messages.mailboxId, f.inbox.id)));
			await tx
				.update(mailboxThreads)
				.set({ mailboxId: trash.id, mailboxSlug: "trash" })
				.where(and(eq(mailboxThreads.threadId, u.threadId), eq(mailboxThreads.mailboxId, f.inbox.id)));
		});
		const mv = moveMail(job(rule.id, [u.threadId], archive.id), new Map());
		assert(await waitsOnLock(), "collision : le job attend la ligne Corbeille de l'autre transaction");
		h.release();
		await h.done;
		let failed: unknown = null;
		await mv.catch((err) => (failed = err));
		assert(!failed, `collision (23505) : le job aboutit (${failed})`);
		const rows = await db.select().from(mailboxThreads).where(eq(mailboxThreads.threadId, u.threadId));
		assert(
			(await boxesOf(u.threadId)).every((b) => b === trash.id) && rows.length === 1 && rows[0].mailboxId === trash.id && rows[0].messageCount === 2,
			`collision : fil en Corbeille une seule fois, 2 messages (${rows.map((r) => `${r.mailboxSlug}:${r.messageCount}`)})`,
		);
		assert((await counterOf(rule.id)).n === n0 + 1, "collision : le fil compte une fois");
	}

	console.log("# sous verrou : etoile posee pendant l'attente, regle suspendue ou duree allongee pendant l'attente");
	{
		const r1 = await msgIn(f, f.inbox.id);
		const r2 = await msgIn(f, f.inbox.id);
		const h = await holding((tx) => tx.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, r1.threadId), eq(mailboxThreads.mailboxId, f.inbox.id))));
		const mv = moveMail(job(rule.id, [r1.threadId, r2.threadId], f.inbox.id), new Map());
		assert(await waitsOnLock(), "etoile : le job attend le verrou de la ligne etoilee");
		h.release();
		await h.done;
		await mv;
		assert(await stays(r1.threadId, f.inbox.id, trash.id), "etoile posee pendant le job : le fil reste");
		assert(await gone(r2.threadId, f.inbox.id, trash.id), "etoile posee pendant le job : l'autre fil part (job rejoue)");
	}
	for (const [label, change, undo] of [
		["regle suspendue", { paused: true }, { paused: false }],
		["duree allongee a 10 ans", { retentionDays: 3650 }, { retentionDays: 30 }],
	] as const) {
		const t = await msgIn(f, f.inbox.id);
		const n0 = (await counterOf(rule.id)).n;
		const h = await holding((tx) => tx.update(cleanupRules).set(change).where(eq(cleanupRules.id, rule.id)));
		const mv = moveMail(job(rule.id, [t.threadId], f.inbox.id), new Map());
		assert(await waitsOnLock(), `${label} : le job attend le verrou de la regle`);
		h.release();
		await h.done;
		await mv;
		assert(await stays(t.threadId, f.inbox.id, trash.id), `${label} pendant le job : le fil reste`);
		assert((await counterOf(rule.id)).n === n0, `${label} pendant le job : compteur inchange`);
		await db.update(cleanupRules).set(undo).where(eq(cleanupRules.id, rule.id));
	}
	{
		const doomed = await ruleOf(f, "regle supprimee pendant le job");
		const t = await msgIn(f, f.inbox.id);
		const h = await holding((tx) => tx.delete(cleanupRules).where(eq(cleanupRules.id, doomed.id)));
		const mv = moveMail(job(doomed.id, [t.threadId], f.inbox.id), new Map());
		assert(await waitsOnLock(), "regle supprimee : le job attend le verrou de la regle");
		h.release();
		await h.done;
		await mv;
		assert(await stays(t.threadId, f.inbox.id, trash.id), "regle supprimee pendant le job : le fil reste");
	}

	console.log("# IMAP : garde \\Flagged, MOVE refuse");
	{
		const g = await createUserFixture("cleanup-move-imap");
		const gArchive = await folderOf(g, "archive", "Archive");
		const gTrash = await folderOf(g, "trash", "Deleted Items");
		for (const [mailboxId, last] of [[gArchive.id, 50], [gTrash.id, 0], [g.inbox.id, 60]] as const) {
			await db.insert(mailboxSync).values({ identityId: g.identity.id, mailboxId, uidValidity: BigInt(1), lastSeenUid: last });
		}
		const gRule = await ruleOf(g, "fil");
		const tA = await msgIn(g, gArchive.id, { uid: 40, path: "Archive" });
		const tA2 = await msgIn(g, gArchive.id, { uid: 41, path: "Archive", thread: tA.threadId });
		const tB = await msgIn(g, gArchive.id, { uid: 42, path: "Archive" });
		const imap = new FakeImap({ Archive: [[40, tA.mid], [41, tA2.mid], [42, tB.mid]], "Deleted Items": [], INBOX: [] });
		imap.flagged.add(tA2.mid);
		const on = new Map([[g.identity.id, imap as unknown as ImapFlow]]);
		await moveMail(job(gRule.id, [tA.threadId, tB.threadId], gArchive.id, true), on);
		const kept = await threadRow(tA.threadId, gArchive.id);
		assert(
			(await stays(tA.threadId, gArchive.id, gTrash.id)) && kept?.starred === true,
			`fil etoile sur le serveur (\\Flagged) : reste en Archive, etoile en base (${kept?.starred})`,
		);
		const sv = imap.folders.get("Archive")!.msgs;
		assert(sv.get(40) === tA.mid && sv.get(41) === tA2.mid, "fil etoile sur le serveur : rien de ce fil deplace sur IMAP");
		assert(
			(await gone(tB.threadId, gArchive.id, gTrash.id)) && [...imap.folders.get("Deleted Items")!.msgs.values()].includes(tB.mid),
			"l'autre fil part en Corbeille, sur IMAP aussi",
		);
		assert((await counterOf(gRule.id)).n === 1, `compteur : seul le fil reellement parti compte (${(await counterOf(gRule.id)).n})`);

		const tC = await msgIn(g, gArchive.id, { uid: 43, path: "Archive" });
		imap.folders.get("Archive")!.msgs.set(43, tC.mid);
		await setRow(tC.threadId, gArchive.id, { expiresAt: X });
		imap.refuseMove = true;
		await expectThrow(() => moveMail(job(gRule.id, [tC.threadId], gArchive.id, true), on), /non deplaces sur IMAP/, "MOVE refuse : le job echoue");
		const back = await threadRow(tC.threadId, gArchive.id);
		assert(
			!!back && back.expiresAt?.getTime() === X.getTime() && !(await threadRow(tC.threadId, gTrash.id)),
			`MOVE refuse : ligne revenue en Archive avec son echeance (${back?.expiresAt})`,
		);
		assert((await counterOf(gRule.id)).n === 1, "MOVE refuse : compteur inchange");

		imap.refuseMove = false;
		const tI = await msgIn(g, g.inbox.id, { uid: 50, path: "INBOX" });
		const tI2 = await msgIn(g, g.inbox.id, { uid: 51, path: "INBOX", thread: tI.threadId });
		const tJ = await msgIn(g, g.inbox.id, { uid: 52, path: "INBOX" });
		const inbox = imap.folders.get("INBOX")!;
		for (const [uid, mid] of [[50, tI.mid], [51, tI2.mid], [52, tJ.mid]] as const) inbox.msgs.set(uid, mid);
		inbox.uidNext = 53;
		imap.flagged.add(tI2.mid);
		await moveMail(job(gRule.id, [tI.threadId, tJ.threadId], g.inbox.id, true), on);
		const keptI = await threadRow(tI.threadId, g.inbox.id);
		assert(
			(await stays(tI.threadId, g.inbox.id, gTrash.id)) && keptI?.starred === true && inbox.msgs.get(50) === tI.mid && inbox.msgs.get(51) === tI2.mid,
			`Inbox : fil etoile sur le serveur (\\Flagged) reste dans l'Inbox, etoile en base, rien deplace sur IMAP (${keptI?.starred})`,
		);
		assert(
			(await gone(tJ.threadId, g.inbox.id, gTrash.id)) && [...imap.folders.get("Deleted Items")!.msgs.values()].includes(tJ.mid),
			"Inbox : l'autre fil part en Corbeille, sur IMAP aussi",
		);
		assert((await counterOf(gRule.id)).n === 2, `Inbox : compteur augmente du seul fil parti (${(await counterOf(gRule.id)).n})`);
	}

	const src = readFileSync(new URL("../lib/imap/imap-move.ts", import.meta.url), "utf8");
	assert(/if \(\(ctx\.expiry \|\| ctx\.cleanup\) && wanted\.size\)/.test(src), "source : garde \\Flagged cablee pour le nettoyage (ctx.expiry || ctx.cleanup)");
	assert(/rule && \(code === "23505" \|\| code === "40P01"\)/.test(src), "source : collision et interblocage entre jobs de nettoyage rejoues");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
