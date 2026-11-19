// moveMail de bout en bout (OI 10286) sur une base de test, avec un faux serveur IMAP qui se
// comporte comme Stalwart : COPYUID permute, SEARCH HEADER Message-ID vide, balayage impossible
// au-dela de 5 000 messages, MOVE refuse (false sans erreur) ou partiel. Verifie : UID recopies
// par Message-ID (par tranches), curseur deltaFetch du dossier d'arrivee (ecrit une fois, apres
// le MOVE, doublons compris), mise a la corbeille IMAP meme quand la page dit « base seule »,
// collisions de cle (mailbox_threads, et messages : meme Message-ID deja a l'arrivee) sans perte
// des autres fils, UID retire des la transaction, retour en base de ce que le serveur n'a pas
// deplace (y compris ce qui n'a jamais ete envoye), IMAP indisponible = rien ne bouge, lot de
// plus de 65 534 UID arrives, et deltaFetch qui ne supprime plus la copie des Envoyes. Gmail (18/11) :
// message deja a l'arrivee (absent de la source) qui reprend son UID par Message-ID, et ligne sans
// UID cherchee par Message-ID au lieu d'un deplacement en base seule. Messages envoyes dont meta
// vaut le JSON `null` (18/11 : 189 lignes, job 8355 en echec) : deplaces, ou remis en place.
// Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55436/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/move-imap.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { moveMail } from "../lib/imap/imap-move";
import { dueExpiredThreads } from "../lib/mail-expiry";
import { deltaFetch } from "../lib/imap/imap-delta-fetch";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;
type Folder = { uidNext: number; msgs: Map<number, string | null> };

class FakeStalwart {
	authenticated = true;
	usable = true;
	refuseMove = false;
	skipOnMove = new Set<number>(); // UID que le serveur « oublie » en repondant OK
	duplicateOnMove = new Set<number>(); // UID dont le serveur depose deux copies a l'arrivee
	vanishOnMove = new Set<number>(); // UID retires de la source sans arriver nulle part
	flood = 0; // messages etrangers arrives dans la destination pendant le MOVE
	existsOverride: number | null = null; // dossier « trop gros » : resolveUids ne balaie pas
	onLock?: (path: string) => Promise<void>;
	onMove?: () => Promise<void>;
	flagged = new Set<string>(); // Message-ID portant \Flagged (pose depuis un autre client)
	moves = 0;
	selected = "";
	folders = new Map<string, Folder>();
	constructor(init: Record<string, { uidNext: number; msgs: Array<[number, string | null]> }>) {
		for (const [p, f] of Object.entries(init)) this.folders.set(p, { uidNext: f.uidNext, msgs: new Map(f.msgs) });
	}
	get mailbox() {
		const f = this.folders.get(this.selected);
		return f ? { path: this.selected, exists: this.existsOverride ?? f.msgs.size, uidNext: f.uidNext } : false;
	}
	async getMailboxLock(path: string) {
		if (!this.folders.has(path)) throw new Error(`no folder ${path}`);
		this.selected = path;
		if (this.onLock) await this.onLock(path);
		return { path, release() {} };
	}
	async mailboxOpen(path: string) {
		this.selected = path;
		return this.mailbox;
	}
	async status(path: string) {
		return { path, uidNext: this.folders.get(path)!.uidNext };
	}
	gmail = false; // X-GM-EXT-1 : SEARCH HEADER Message-ID et X-GM-RAW « rfc822msgid: » repondent
	get capabilities() {
		return new Map(this.gmail ? [["X-GM-EXT-1", true]] : []);
	}
	async search(q: any = {}) {
		if (!this.gmail) return []; // Stalwart ne rend rien sur SEARCH HEADER Message-ID
		const norm = (v: unknown) => String(v ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
		const want = norm(q.header ? q.header["message-id"] : String(q.gmraw ?? "").replace(/^rfc822msgid:/, ""));
		return [...this.folders.get(this.selected)!.msgs].filter(([, m]) => norm(m) === want).map(([u]) => u);
	}
	async *fetch(range: string | { uid: string }) {
		const f = this.folders.get(this.selected)!;
		const all = [...f.msgs.keys()].sort((a, b) => a - b);
		const r = typeof range === "string" ? range : range.uid;
		let pick: number[];
		if (r.endsWith(":*")) {
			const a = Number(r.split(":")[0]);
			pick = all.filter((u) => u >= a);
			if (!pick.length && all.length) pick = [all[all.length - 1]];
		} else if (/^\d+:\d+$/.test(r)) {
			const [a, b] = r.split(":").map(Number);
			pick = all.filter((u) => u >= a && u <= b);
		} else {
			pick = r.split(",").map(Number).filter((u) => f.msgs.has(u));
		}
		for (const uid of pick) {
			const mid = f.msgs.get(uid);
			yield {
				uid,
				envelope: { messageId: mid ?? undefined },
				flags: new Set<string>(mid && this.flagged.has(mid) ? ["\\Seen", "\\Flagged"] : ["\\Seen"]),
				internalDate: new Date(),
				size: 10,
				source: Buffer.from(`Message-ID: ${mid}\r\nSubject: x\r\n\r\ncorps`),
			};
		}
	}
	async messageMove(uids: number[], dest: string) {
		this.moves++;
		if (this.onMove) await this.onMove();
		if (this.refuseMove) return false;
		const s = this.folders.get(this.selected)!;
		const d = this.folders.get(dest)!;
		const present = uids.filter((u) => s.msgs.has(u) && !this.skipOnMove.has(u)).sort((a, b) => a - b);
		const destUids: number[] = [];
		for (const u of uids) if (this.vanishOnMove.has(u)) s.msgs.delete(u);
		for (const u of present) {
			if (this.vanishOnMove.has(u)) continue;
			const nu = d.uidNext++;
			d.msgs.set(nu, s.msgs.get(u)!);
			if (this.duplicateOnMove.has(u)) d.msgs.set(d.uidNext++, s.msgs.get(u)!);
			s.msgs.delete(u);
			destUids.push(nu);
		}
		for (let i = 0; i < this.flood; i++) d.msgs.set(d.uidNext++, `<flot-${i}@ailleurs.invalid>`);
		// COPYUID a la Stalwart : les deux ensembles ne se correspondent pas dans l'ordre
		return { path: this.selected, destination: dest, uidMap: new Map(present.map((u, i) => [u, destUids[destUids.length - 1 - i]])) };
	}
}

async function trashOf(f: Fixture) {
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			kind: "trash",
			name: "Deleted Items",
			slug: "trash",
			isDefault: true,
			metaData: { imap: { path: "Deleted Items" } },
		})
		.returning();
	return row;
}

async function folderOf(f: Fixture, kind: "archive" | "spam" | "custom", name: string) {
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

const on = (f: Fixture, imap: FakeStalwart) => new Map([[f.identity.id, imap as unknown as ImapFlow]]);

async function syncRow(f: Fixture, mailboxId: string, lastSeenUid: number) {
	await db.insert(mailboxSync).values({ identityId: f.identity.id, mailboxId, uidValidity: BigInt(1), lastSeenUid });
}

async function cursorOf(mailboxId: string) {
	const [r] = await db.select().from(mailboxSync).where(eq(mailboxSync.mailboxId, mailboxId));
	return Number(r.lastSeenUid);
}

// Un fil de messages dans `mailboxId` ; uid null = message sans UID IMAP.
async function thread(f: Fixture, mailboxId: string, items: Array<{ mid: string; uid: number | null; path?: string; nullMeta?: boolean }>) {
	const [t] = await db
		.insert(threads)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() })
		.returning();
	const ids: string[] = [];
	for (const [i, it] of items.entries()) {
		const [m] = await db
			.insert(messages)
			.values({
				ownerId: f.user.id,
				workspaceId: f.workspace.id,
				mailboxId,
				threadId: t.id,
				messageId: it.mid,
				subject: `fil ${it.mid}`,
				text: "corps",
				date: new Date(Date.now() - (items.length - i) * 60_000),
				seen: false,
				metaData: it.uid === null ? {} : { imap: { uid: it.uid, mailboxPath: it.path ?? "INBOX" } },
			} as any)
			.returning();
		ids.push(m.id);
		// JSON `null` (jsonb 'null'), pas le NULL SQL : drizzle ecrit un NULL SQL pour `null`.
		if (it.nullMeta) await db.execute(sql`update messages set meta = 'null'::jsonb where id = ${m.id}::uuid`);
	}
	await upsertMailboxThreadItem(ids[ids.length - 1]);
	return { id: t.id, ids };
}

// Un fil de beaucoup de messages, inseres par paquets (UID consecutifs a partir de firstUid).
async function bigThread(f: Fixture, mailboxId: string, mids: string[], firstUid: number) {
	const [t] = await db
		.insert(threads)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() })
		.returning();
	const ids: string[] = [];
	for (let i = 0; i < mids.length; i += 500) {
		const rows = await db
			.insert(messages)
			.values(
				mids.slice(i, i + 500).map((mid, k) => ({
					ownerId: f.user.id,
					workspaceId: f.workspace.id,
					mailboxId,
					threadId: t.id,
					messageId: mid,
					subject: "gros lot",
					text: "corps",
					date: new Date(Date.now() - (mids.length - i - k) * 1000),
					seen: true,
					metaData: { imap: { uid: firstUid + i + k, mailboxPath: "INBOX" } },
				})) as any,
			)
			.returning({ id: messages.id });
		ids.push(...rows.map((r) => r.id));
	}
	await upsertMailboxThreadItem(ids[ids.length - 1]);
	return { id: t.id, ids };
}

const msgRows = (ids: string[]) =>
	db.select().from(messages).where(inArray(messages.id, ids));

const threadRow = async (threadId: string, mailboxId: string) =>
	(
		await db
			.select()
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)))
	)[0];

const job = (threadIds: string[], mailboxId: string, moveImap: boolean) => ({
	threadId: threadIds[0],
	threadIds,
	mailboxId,
	op: "trash" as const,
	moveImap,
});

// Archiver avec une duree de vie : job de Corbeille poste par mail:expire-tick.
const expiryJob = (threadIds: string[], mailboxId: string, moveImap: boolean) => ({ ...job(threadIds, mailboxId, moveImap), expiry: true });

const expOf = async (threadId: string, mailboxId: string) => (await threadRow(threadId, mailboxId))?.expiresAt ?? null;

const setExp = (threadId: string, mailboxId: string, at: Date | null) =>
	db
		.update(mailboxThreads)
		.set({ expiresAt: at })
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));

// Un message de plus dans un fil existant, ligne de fil du dossier recalculee.
async function addMsg(f: Fixture, mailboxId: string, threadId: string, mid: string, uid: number | null = null, path = "INBOX") {
	const [m] = await db
		.insert(messages)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			mailboxId,
			threadId,
			messageId: mid,
			subject: `fil ${mid}`,
			text: "corps",
			date: new Date(),
			seen: false,
			metaData: uid === null ? {} : { imap: { uid, mailboxPath: path } },
		} as any)
		.returning();
	await upsertMailboxThreadItem(m.id);
	return m.id;
}

async function main() {
	// 1. Corbeille demandee en « base seule » par une page sans etat de synchro, dossier
	//    synchronise : MOVE IMAP fait ; COPYUID permute, UID recopies par Message-ID ; curseur.
	{
		const f = await createUserFixture("move-perm");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 930);
		await syncRow(f, trash.id, 99);
		const mids = Array.from({ length: 8 }, (_, i) => `<perm${i}-${Date.now()}@test.invalid>`);
		const imap = new FakeStalwart({
			INBOX: { uidNext: 931, msgs: mids.map((m, i) => [920 + i, m]) },
			"Deleted Items": { uidNext: 100, msgs: [] },
		});
		const t1 = await thread(f, f.inbox.id, mids.slice(0, 2).map((mid, i) => ({ mid, uid: 920 + i })));
		const t2 = await thread(f, f.inbox.id, mids.slice(2).map((mid, i) => ({ mid, uid: 922 + i })));
		// Etat de la base vu depuis le serveur : juste apres la transaction (premier verrou) et
		// pendant le MOVE.
		let uidSurChemin = -1;
		let curseurPendantMove = -1;
		imap.onLock = async () => {
			if (uidSurChemin >= 0) return;
			const r = await msgRows([...t1.ids, ...t2.ids]);
			uidSurChemin = r.filter((x) => (x.metaData as any)?.imap?.mailboxPath === "Deleted Items" && (x.metaData as any)?.imap?.uid !== undefined).length;
		};
		imap.onMove = async () => {
			curseurPendantMove = await cursorOf(trash.id);
		};
		await moveMail(job([t1.id, t2.id], f.inbox.id, false), on(f, imap));
		assert(uidSurChemin === 0, `apres la transaction, aucun UID de la source sur le chemin d'arrivee (${uidSurChemin})`);
		assert(curseurPendantMove === 99, `curseur de la corbeille inchange pendant le MOVE (${curseurPendantMove})`);

		assert(imap.moves === 1, "base seule demandee, dossier synchronise : un UID MOVE IMAP");
		const rows = await msgRows([...t1.ids, ...t2.ids]);
		const dest = imap.folders.get("Deleted Items")!;
		const ok = rows.filter((r) => {
			const uid = (r.metaData as any)?.imap?.uid;
			return r.mailboxId === trash.id && dest.msgs.get(uid) === r.messageId && (r.metaData as any)?.imap?.mailboxPath === "Deleted Items";
		});
		assert(ok.length === 8, `8/8 UID designent leur propre message malgre le COPYUID permute (${ok.length})`);
		assert(imap.folders.get("INBOX")!.msgs.size === 0, "INBOX IMAP videe");
		assert((await cursorOf(trash.id)) === 107, "curseur deltaFetch de la corbeille sur le dernier UID du lot (107)");
		assert(!!(await threadRow(t2.id, trash.id)) && !(await threadRow(t2.id, f.inbox.id)), "ligne de fil passee en corbeille");
	}

	// 2. Collision de cle : un fil a deja sa ligne en corbeille ; les autres fils du lot partent.
	{
		const f = await createUserFixture("move-clash");
		const trash = await trashOf(f);
		const t3 = await thread(f, f.inbox.id, [{ mid: `<c1-${Date.now()}@x>`, uid: null }]);
		const [old] = await db
			.insert(messages)
			.values({
				ownerId: f.user.id,
				workspaceId: f.workspace.id,
				mailboxId: trash.id,
				threadId: t3.id,
				messageId: `<c0-${Date.now()}@x>`,
				subject: "deja en corbeille",
				text: "x",
				date: new Date(Date.now() - 3_600_000),
				seen: true,
			} as any)
			.returning();
		await upsertMailboxThreadItem(old.id);
		const t4 = await thread(f, f.inbox.id, [{ mid: `<c2-${Date.now()}@x>`, uid: null }]);
		let error: unknown = null;
		await moveMail(job([t3.id, t4.id], f.inbox.id, false), new Map()).catch((e) => (error = e));
		assert(error === null, `collision de cle : le job ne leve pas (${error})`);
		const merged = await threadRow(t3.id, trash.id);
		assert(merged?.messageCount === 2 && merged?.unreadCount === 1, "fil deja en corbeille : lignes fusionnees (2 messages, 1 non lu)");
		assert(!(await threadRow(t3.id, f.inbox.id)), "plus de ligne Inbox pour le fil fusionne");
		assert(!!(await threadRow(t4.id, trash.id)), "l'autre fil du lot est bien en corbeille");
		const moved = await msgRows([...t3.ids, ...t4.ids]);
		assert(moved.every((m) => m.mailboxId === trash.id), "tous les messages du lot en corbeille");
	}

	// 3. MOVE refuse par le serveur (false sans erreur) : base remise en Inbox, job en echec.
	{
		const f = await createUserFixture("move-refuse");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 20);
		await syncRow(f, trash.id, 9);
		const mids = [`<r1-${Date.now()}@x>`, `<r2-${Date.now()}@x>`];
		const imap = new FakeStalwart({
			INBOX: { uidNext: 21, msgs: [[11, mids[0]], [12, mids[1]]] },
			"Deleted Items": { uidNext: 10, msgs: [] },
		});
		imap.refuseMove = true;
		const t5 = await thread(f, f.inbox.id, mids.map((mid, i) => ({ mid, uid: 11 + i })));
		await expectThrow(
			() => moveMail(job([t5.id], f.inbox.id, true), new Map([[f.identity.id, imap as unknown as ImapFlow]])),
			/2 message\(s\) non deplaces sur IMAP/,
			"MOVE refuse : le job echoue (rejoue par BullMQ)",
		);
		const rows = await msgRows(t5.ids);
		assert(
			rows.every((r) => r.mailboxId === f.inbox.id && (r.metaData as any)?.imap?.mailboxPath === "INBOX") &&
				rows.map((r) => (r.metaData as any)?.imap?.uid).sort().join(",") === "11,12",
			"MOVE refuse : messages remis dans l'Inbox en base, chemin et UID d'origine",
		);
		const back = await threadRow(t5.id, f.inbox.id);
		assert(!!back && back.messageCount === 2 && !(await threadRow(t5.id, trash.id)), "MOVE refuse : ligne de fil revenue dans l'Inbox");
		assert((await cursorOf(trash.id)) === 9, "MOVE refuse : curseur de la corbeille rendu a sa valeur");
	}

	// 4. MOVE partiel (OK du serveur) : un message reste dans la source, un autre disparait.
	{
		const f = await createUserFixture("move-partiel");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 40);
		await syncRow(f, trash.id, 4);
		const mids = [`<p1-${Date.now()}@x>`, `<p2-${Date.now()}@x>`, `<p3-${Date.now()}@x>`];
		const imap = new FakeStalwart({
			INBOX: { uidNext: 41, msgs: [[31, mids[0]], [32, mids[1]], [33, mids[2]]] },
			"Deleted Items": { uidNext: 5, msgs: [] },
		});
		imap.skipOnMove.add(32);
		imap.vanishOnMove.add(33);
		const t6 = await thread(f, f.inbox.id, mids.map((mid, i) => ({ mid, uid: 31 + i })));
		await expectThrow(
			() => moveMail(job([t6.id], f.inbox.id, true), on(f, imap)),
			/1 message\(s\) non deplaces sur IMAP/,
			"MOVE partiel : le job echoue pour le message reste dans la source",
		);
		const rows = new Map((await msgRows(t6.ids)).map((r) => [r.messageId, r]));
		const p1 = rows.get(mids[0])!;
		const p2 = rows.get(mids[1])!;
		const p3 = rows.get(mids[2])!;
		assert(p1.mailboxId === trash.id && (p1.metaData as any).imap.uid === 5, "MOVE partiel : message arrive, UID d'arrivee 5");
		assert(p2.mailboxId === f.inbox.id && (p2.metaData as any).imap.uid === 32, "MOVE partiel : message reste sur le serveur remis dans l'Inbox (UID 32)");
		assert(p3.mailboxId === trash.id && (p3.metaData as any).imap.uid === undefined, "envoye puis introuvable partout : en corbeille, sans UID");
		assert(!!(await threadRow(t6.id, f.inbox.id)) && !!(await threadRow(t6.id, trash.id)), "fil reparti sur les deux dossiers, une ligne chacun");
		assert((await threadRow(t6.id, trash.id))!.messageCount === 2, "ligne corbeille recalculee (2 messages)");
		assert((await cursorOf(trash.id)) === 5, "curseur de la corbeille sur l'UID arrive (5)");
	}

	// 5. IMAP indisponible : rien ne bouge, ni en base ni sur le serveur.
	{
		const f = await createUserFixture("move-down");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 5);
		const t7 = await thread(f, f.inbox.id, [{ mid: `<d1-${Date.now()}@x>`, uid: 3 }]);
		await expectThrow(
			() => moveMail(job([t7.id], f.inbox.id, false), new Map()),
			/IMAP indisponible/,
			"IMAP indisponible : le job echoue",
		);
		const [r] = await msgRows(t7.ids);
		assert(r.mailboxId === f.inbox.id && !(await threadRow(t7.id, trash.id)), "IMAP indisponible : base inchangee");
	}

	// 6. Message jamais envoye dans le MOVE : UID perime en base, dossier source de plus de 5 000
	//    messages (pas de balayage), SEARCH HEADER vide. Il est remis dans la source et non laisse
	//    « a destination sans UID » ; le reste du lot part.
	{
		const f = await createUserFixture("move-perime");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const a = `<perime-a-${Date.now()}@x>`;
		const b = `<perime-b-${Date.now()}@x>`;
		const c = `<autre-fil-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[200, a], [201, b], [250, c]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.existsOverride = 6000;
		// a est en realite a 200 ; la base dit 250, qui designe c (un autre fil)
		const t8 = await thread(f, f.inbox.id, [{ mid: a, uid: 250 }, { mid: b, uid: 201 }]);
		await expectThrow(
			() => moveMail(job([t8.id], f.inbox.id, true), on(f, imap)),
			/1 message\(s\) non deplaces sur IMAP/,
			"UID perime : le job echoue pour le message jamais envoye",
		);
		const rows = new Map((await msgRows(t8.ids)).map((r) => [r.messageId, r]));
		const ra = rows.get(a)!;
		const rb = rows.get(b)!;
		assert(
			ra.mailboxId === f.inbox.id && (ra.metaData as any).imap.uid === 250 && (ra.metaData as any).imap.mailboxPath === "INBOX",
			"UID perime : message remis dans l'Inbox en base, pas a destination sans UID",
		);
		assert(rb.mailboxId === trash.id && (rb.metaData as any).imap.uid === 1, "UID perime : l'autre message du lot est parti (UID 1)");
		assert(
			imap.folders.get("INBOX")!.msgs.get(250) === c && imap.folders.get("INBOX")!.msgs.get(200) === a,
			"UID perime : rien d'autre n'a bouge sur le serveur",
		);
		assert(!!(await threadRow(t8.id, f.inbox.id)) && !!(await threadRow(t8.id, trash.id)), "UID perime : fil reparti, une ligne par dossier");
	}

	// 6 bis. Incident du 12/11 (Spam Gmail de sam.legros@) : messages deja supprimes du serveur
	//    (absents de la source, relue en entier : dossier de moins de 5 000 messages) mais
	//    restes en base. Ils ne sont plus remis dans la source (ils revenaient a chaque « vider
	//    le spam ») : ils restent a destination sans UID, le reste du lot part, le job reussit.
	{
		const f = await createUserFixture("move-fantome");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const g = `<fantome-${Date.now()}@x>`;
		const p = `<present-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[201, p]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		const tg = await thread(f, f.inbox.id, [{ mid: g, uid: 200 }]);
		const tp = await thread(f, f.inbox.id, [{ mid: p, uid: 201 }]);
		let error: unknown = null;
		await moveMail(job([tg.id, tp.id], f.inbox.id, true), on(f, imap)).catch((e) => (error = e));
		assert(error === null, `message supprime du serveur : le job ne leve pas (${error})`);
		const [rg] = await msgRows(tg.ids);
		assert(
			rg.mailboxId === trash.id && (rg.metaData as any).imap.uid === undefined,
			"message supprime du serveur : laisse a destination sans UID, pas remis dans la source",
		);
		const [rp] = await msgRows(tp.ids);
		assert(rp.mailboxId === trash.id && (rp.metaData as any).imap.uid === 1, "l'autre fil du lot est parti (UID 1)");
		assert(!(await threadRow(tg.id, f.inbox.id)), "plus de ligne source pour le fil supprime du serveur");
	}

	// 7. Meme Message-ID deja dans le dossier d'arrivee (index unique mailbox_id + message_id) :
	//    la ligne source est supprimee, la copie IMAP part quand meme, le curseur la compte.
	{
		const f = await createUserFixture("move-copie");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 70);
		await syncRow(f, trash.id, 9);
		const x = `<copie-${Date.now()}@x>`;
		const y = `<seul-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 71, msgs: [[61, x], [62, y]] },
			"Deleted Items": { uidNext: 10, msgs: [[3, x]] },
		});
		const old = await thread(f, trash.id, [{ mid: x, uid: 3, path: "Deleted Items" }]);
		const t9 = await thread(f, f.inbox.id, [{ mid: x, uid: 61 }, { mid: y, uid: 62 }]);
		let error: unknown = null;
		await moveMail(job([t9.id], f.inbox.id, false), on(f, imap)).catch((e) => (error = e));
		assert(error === null, `meme Message-ID deja a l'arrivee : le job ne leve pas (${error})`);
		const rows = await msgRows([...t9.ids, ...old.ids]);
		const xs = rows.filter((r) => r.messageId === x);
		assert(
			xs.length === 1 && xs[0].id === old.ids[0] && (xs[0].metaData as any).imap.uid === 3,
			"ligne source supprimee, copie deja a l'arrivee intacte (UID 3)",
		);
		const ry = rows.find((r) => r.messageId === y)!;
		assert(
			ry.mailboxId === trash.id && imap.folders.get("Deleted Items")!.msgs.get((ry.metaData as any).imap.uid) === y,
			"l'autre message du fil est en corbeille avec son UID",
		);
		assert(imap.folders.get("INBOX")!.msgs.size === 0, "la copie IMAP est deplacee elle aussi (INBOX vide)");
		assert((await cursorOf(trash.id)) === 11, "curseur sur le dernier UID (11) : l'UID d'arrivee de la copie compte comme connu");
		assert((await threadRow(t9.id, trash.id))?.messageCount === 1, "ligne de fil recalculee (1 message)");
	}

	// 8. Deux copies deposees a l'arrivee pour un message : UID le plus recent, et le curseur ne
	//    redescend pas sous le lot.
	{
		const f = await createUserFixture("move-double");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 20);
		await syncRow(f, trash.id, 4);
		const d = `<double-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 21, msgs: [[15, d]] },
			"Deleted Items": { uidNext: 5, msgs: [] },
		});
		imap.duplicateOnMove.add(15);
		const t10 = await thread(f, f.inbox.id, [{ mid: d, uid: 15 }]);
		await moveMail(job([t10.id], f.inbox.id, true), on(f, imap));
		const [r] = await msgRows(t10.ids);
		assert((r.metaData as any).imap.uid === 6, "deux copies a l'arrivee : UID le plus recent (6)");
		assert((await cursorOf(trash.id)) === 6, "deux copies a l'arrivee : curseur au-dessus des deux (6)");
	}

	// 9. Gros lot : 2 500 messages et 70 000 arrivees etrangeres pendant le MOVE (plus de
	//    65 534 UID a verifier en base) ; UID recopies par tranches.
	{
		const f = await createUserFixture("move-gros");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 10_000);
		await syncRow(f, trash.id, 0);
		const n = 2500;
		const mids = Array.from({ length: n }, (_, i) => `<gros${i}-${Date.now()}@x>`);
		const imap = new FakeStalwart({
			INBOX: { uidNext: 10_001, msgs: mids.map((m, i) => [5000 + i, m] as [number, string]) },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.flood = 70_000;
		const t11 = await bigThread(f, f.inbox.id, mids, 5000);
		const t0 = Date.now();
		let error: unknown = null;
		await moveMail(job([t11.id], f.inbox.id, true), on(f, imap)).catch((e) => (error = e));
		const dt = ((Date.now() - t0) / 1000).toFixed(1);
		assert(error === null, `gros lot : le job ne leve pas (${error})`);
		const dest = imap.folders.get("Deleted Items")!;
		const ok = (await msgRows(t11.ids)).filter(
			(r) => r.mailboxId === trash.id && dest.msgs.get((r.metaData as any)?.imap?.uid) === r.messageId,
		).length;
		assert(ok === n, `gros lot : ${ok}/${n} UID justes, en ${dt} s`);
		assert((await cursorOf(trash.id)) === n, "gros lot : curseur juste sous la premiere arrivee etrangere (2500)");
	}

	// 10. deltaFetch : un message deja dans ce dossier en base n'est jamais un « deplacement »,
	//     et la copie des Envoyes (meme Message-ID) n'est plus supprimee.
	{
		const f = await createUserFixture("delta-envoyes");
		const archive = await folderOf(f, "archive", "Archive");
		await syncRow(f, archive.id, 0);
		const x = `<envoye-a-soi-${Date.now()}@x>`;
		const sent = await thread(f, f.sent.id, [{ mid: x, uid: 7, path: "Sent" }]);
		const arch = await thread(f, archive.id, [{ mid: x, uid: 1, path: "Archive" }]);
		const imap = new FakeStalwart({ Archive: { uidNext: 2, msgs: [[1, x]] } });
		await deltaFetch(f.identity.id, on(f, imap));
		const rows = await msgRows([...sent.ids, ...arch.ids]);
		const s1 = rows.find((r) => r.id === sent.ids[0]);
		assert(!!s1 && s1.mailboxId === f.sent.id, "deltaFetch : la copie des Envoyes existe toujours, dans les Envoyes");
		assert(rows.find((r) => r.id === arch.ids[0])?.mailboxId === archive.id, "deltaFetch : la copie de l'Archive n'a pas bouge");
		assert((await cursorOf(archive.id)) === 1, "deltaFetch : curseur de l'Archive avance (1)");
	}

	// 11. Incident du 05/11 (reponse d'OPTI MARCHE rangee dans les Envoyes) : un message envoye
	//     qui revient aussi dans l'INBOX (liste dev@ en copie) est une copie, pas un deplacement.
	//     Avant : allers-retours INBOX <-> Envoyes, et le dernier emportait dans les Envoyes la
	//     reponse recue entre-temps dans l'INBOX.
	{
		const f = await createUserFixture("delta-copie-envoye");
		const x = `<envoye-liste-${Date.now()}@x>`;
		const reply = `<reponse-cliente-${Date.now()}@x>`;
		const sent = await thread(f, f.sent.id, [{ mid: x, uid: 7, path: "Sent" }]);
		const [r] = await db
			.insert(messages)
			.values({
				ownerId: f.user.id,
				workspaceId: f.workspace.id,
				mailboxId: f.inbox.id,
				threadId: sent.id,
				messageId: reply,
				subject: "RE: fil",
				text: "Merci Hugo",
				date: new Date(),
				seen: false,
				metaData: { imap: { uid: 2, mailboxPath: "Inbox" } },
			} as any)
			.returning();
		await upsertMailboxThreadItem(r.id);
		for (const id of [f.inbox.id, f.sent.id]) await syncRow(f, id, 0).catch(() => {});
		const imap = new FakeStalwart({ Inbox: { uidNext: 3, msgs: [[1, x], [2, reply]] }, Sent: { uidNext: 8, msgs: [[7, x]] } });
		// deux passages : l'INBOX puis les Envoyes, comme le worker en production
		for (let i = 0; i < 2; i++) await deltaFetch(f.identity.id, on(f, imap)).catch((e) => console.warn("deltaFetch", String(e)));
		const rows = await msgRows([...sent.ids, r.id]);
		assert(rows.find((m) => m.id === r.id)?.mailboxId === f.inbox.id, "copie d'un envoye : la reponse de la cliente reste dans l'INBOX");
		assert(rows.find((m) => m.id === sent.ids[0])?.mailboxId === f.sent.id, "copie d'un envoye : le message envoye reste dans les Envoyes");
	}

	// 12. Gmail de sam.legros@ (16 et 18/11 : 526 messages archives sans UID) : message deja
	//     archive par un autre client, absent de l'INBOX Gmail (absence prouvee) mais present dans
	//     « Tous les messages » a son UID d'origine. Il reprend cet UID par Message-ID, sans MOVE ;
	//     un UID deja tenu par une autre ligne du dossier n'est jamais pris ; un message supprime
	//     partout reste a destination sans UID ; celui qui est encore dans l'INBOX part par le MOVE
	//     dans le meme lot ; le job reussit.
	{
		const f = await createUserFixture("move-gmail-deja-archive");
		const all = await folderOf(f, "archive", "[Gmail]/Tous les messages");
		await syncRow(f, f.inbox.id, 9000);
		await syncRow(f, all.id, 9000);
		const a = `<Deja-Archive-${Date.now()}@x>`;
		const pris = `<uid-pris-${Date.now()}@x>`;
		const supprime = `<supprime-partout-${Date.now()}@x>`;
		const present = `<encore-en-inbox-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 9001, msgs: [[8000, `<sans-rapport-${Date.now()}@x>`], [8001, present]] },
			"[Gmail]/Tous les messages": { uidNext: 9001, msgs: [[500, a.toLowerCase()], [501, pris]] },
		});
		imap.gmail = true;
		imap.existsOverride = 9000; // gros dossiers Gmail : jamais balayes, SEARCH seulement
		const autre = await thread(f, all.id, [{ mid: `<autre-ligne-${Date.now()}@x>`, uid: 501, path: "[Gmail]/Tous les messages" }]);
		const t = await thread(f, f.inbox.id, [{ mid: a, uid: 7000 }, { mid: pris, uid: 7001 }, { mid: supprime, uid: 7002 }, { mid: present, uid: 8001 }]);
		let error: unknown = null;
		await moveMail({ threadId: t.id, threadIds: [t.id], mailboxId: f.inbox.id, op: "archive", moveImap: true }, on(f, imap)).catch((e) => (error = e));
		assert(error === null, `Gmail, deja archive : le job ne leve pas (${error})`);
		assert(imap.moves === 1 && !imap.folders.get("INBOX")!.msgs.has(8001), `Gmail, deja archive : un seul UID MOVE, pour le message encore dans l'INBOX (${imap.moves})`);
		const rows = new Map((await msgRows(t.ids)).map((r) => [r.messageId, r]));
		const ra = rows.get(a)!;
		assert(
			ra.mailboxId === all.id && (ra.metaData as any).imap.uid === 500 && (ra.metaData as any).imap.mailboxPath === "[Gmail]/Tous les messages",
			`Gmail, deja archive : UID de « Tous les messages » repris par Message-ID (${JSON.stringify((ra.metaData as any).imap)})`,
		);
		const rp = rows.get(pris)!;
		assert(rp.mailboxId === all.id && (rp.metaData as any).imap.uid === undefined, "Gmail, deja archive : UID tenu par une autre ligne du dossier jamais pris");
		const [ro] = await msgRows(autre.ids);
		assert((ro.metaData as any).imap.uid === 501, "Gmail, deja archive : l'autre ligne garde son UID");
		const rs = rows.get(supprime)!;
		assert(rs.mailboxId === all.id && (rs.metaData as any).imap.uid === undefined, "Gmail, supprime partout : a destination sans UID");
		const rn = rows.get(present)!;
		assert(rn.mailboxId === all.id && (rn.metaData as any).imap.uid === 9001, `Gmail, encore dans l'INBOX : UID d'arrivee du MOVE (${JSON.stringify((rn.metaData as any).imap)})`);
		assert((await cursorOf(all.id)) === 9001, "Gmail, deja archive : curseur de « Tous les messages » au-dela du seul message arrive");
	}

	// 13. Ligne sans UID dans un dossier synchronise (laissee sans UID par un deplacement
	//     precedent) : cherchee par Message-ID dans la source au lieu d'un deplacement « en base
	//     seule » (la base disait Corbeille, Gmail gardait le message dans l'INBOX). Introuvable
	//     sans preuve d'absence (gros dossier Stalwart, SEARCH en echec) : deplacee en base seule
	//     comme avant, sans UID, et le job reussit (jamais de job qui echoue sans fin pour elle).
	{
		const f = await createUserFixture("move-sans-uid");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const s = `<sans-uid-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[210, s]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.gmail = true;
		// chemin IMAP du dossier, comme en production (la fixture n'a que le nom « Inbox »)
		await db.update(mailboxes).set({ metaData: { imap: { path: "INBOX" } } }).where(eq(mailboxes.id, f.inbox.id));
		const ts = await thread(f, f.inbox.id, [{ mid: s, uid: null }]);
		await moveMail(job([ts.id], f.inbox.id, true), on(f, imap));
		assert(imap.moves === 1 && !imap.folders.get("INBOX")!.msgs.has(210), "sans UID : MOVE IMAP fait (trouve par Message-ID)");
		const [r] = await msgRows(ts.ids);
		assert(
			r.mailboxId === trash.id && (r.metaData as any)?.imap?.uid === 1 && imap.folders.get("Deleted Items")!.msgs.get(1) === s,
			`sans UID : en corbeille avec son UID d'arrivee (${JSON.stringify(r.metaData)})`,
		);

		const f2 = await createUserFixture("move-sans-uid-introuvable");
		const trash2 = await trashOf(f2);
		await syncRow(f2, f2.inbox.id, 300);
		await syncRow(f2, trash2.id, 0);
		const n = `<introuvable-${Date.now()}@x>`;
		const imap2 = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[220, n]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap2.existsOverride = 6000;
		await db.update(mailboxes).set({ metaData: { imap: { path: "INBOX" } } }).where(eq(mailboxes.id, f2.inbox.id));
		const tn = await thread(f2, f2.inbox.id, [{ mid: n, uid: null }]);
		let error2: unknown = null;
		await moveMail(job([tn.id], f2.inbox.id, true), on(f2, imap2)).catch((e) => (error2 = e));
		assert(error2 === null, `sans UID, introuvable sans preuve : le job ne leve pas (${error2})`);
		const [r2] = await msgRows(tn.ids);
		assert(
			r2.mailboxId === trash2.id && (r2.metaData as any)?.imap?.uid === undefined && imap2.moves === 0 && imap2.folders.get("INBOX")!.msgs.has(220),
			`sans UID, introuvable sans preuve : en corbeille en base seule, sans UID, serveur inchange (${JSON.stringify(r2.metaData)})`,
		);
	}

	// 14. Messages envoyes dont meta vaut le JSON `null` (pas le NULL SQL : drizzle ecrit `null` en
	//     jsonb 'null', 189 lignes en production, job mail:move 8355 du 13/11 en echec) : coalesce
	//     ne les remplace pas, `'null'::jsonb || objet` fabrique un tableau et jsonb_set y echoue.
	//     Le deplacement reussit (UID d'arrivee recopie) ; un message que le serveur n'a pas
	//     deplace est remis dans la source avec un meta objet.
	{
		const f = await createUserFixture("move-meta-null");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 300);
		await syncRow(f, trash.id, 0);
		const a = `<meta-null-a-${Date.now()}@x>`;
		const b = `<meta-null-b-${Date.now()}@x>`;
		const imap = new FakeStalwart({
			INBOX: { uidNext: 301, msgs: [[210, a], [211, b]] },
			"Deleted Items": { uidNext: 1, msgs: [] },
		});
		imap.skipOnMove.add(211);
		await db.update(mailboxes).set({ metaData: { imap: { path: "INBOX" } } }).where(eq(mailboxes.id, f.inbox.id));
		const ta = await thread(f, f.inbox.id, [{ mid: a, uid: null, nullMeta: true }]);
		const tb = await thread(f, f.inbox.id, [{ mid: b, uid: null, nullMeta: true }]);
		const typeOf = async (id: string) =>
			String((await db.execute(sql`select coalesce(jsonb_typeof(meta), 'sql-null') as t from messages where id = ${id}::uuid`))[0]?.t);
		assert((await typeOf(ta.ids[0])) === "null", "meta a null : la fixture ecrit bien le JSON null");
		let error: unknown = null;
		await moveMail(job([ta.id], f.inbox.id, true), on(f, imap)).catch((e) => (error = e));
		assert(error === null, `meta a null : le job ne leve pas (${error})`);
		const [ra] = await msgRows(ta.ids);
		assert(
			ra.mailboxId === trash.id && (ra.metaData as any)?.imap?.mailboxPath === "Deleted Items" && imap.folders.get("Deleted Items")!.msgs.get(1) === a && (ra.metaData as any)?.imap?.uid === 1,
			`meta a null : en corbeille avec chemin et UID d'arrivee (${JSON.stringify(ra.metaData)})`,
		);
		await expectThrow(() => moveMail(job([tb.id], f.inbox.id, true), on(f, imap)), /non deplaces sur IMAP/, "meta a null, non deplace par le serveur : le job echoue pour etre rejoue");
		const [rb] = await msgRows(tb.ids);
		assert(
			rb.mailboxId === f.inbox.id && (await typeOf(tb.ids[0])) === "object" && (rb.metaData as any)?.imap?.mailboxPath === "INBOX" && imap.folders.get("INBOX")!.msgs.has(211),
			`meta a null, non deplace par le serveur : remis dans l'INBOX, meta objet (${JSON.stringify(rb.metaData)})`,
		);
	}

	// 15. Archiver avec une duree de vie (docs/plans/archive-duree-de-vie.md, bloc 2) : l'echeance
	//     voyage dans le job (op archive, expiresAt) et moveMail l'ecrit sur la ligne d'arrivee,
	//     dans la transaction du deplacement ; tout autre deplacement ecrit NULL. Le job de
	//     Corbeille du tick (expiry: true) revérifie l'echeance au moment d'executer.
	const X = new Date(Date.now() + 30 * 86_400_000);
	const PAST = new Date(Date.now() - 3_600_000);
	const same = (a: Date | null, b: Date) => !!a && a.getTime() === b.getTime();
	{
		const f = await createUserFixture("expiry-archive");
		const archive = await folderOf(f, "archive", "Archive");
		const custom = await folderOf(f, "custom", "Projets");
		const tag = Date.now();

		// a) chemin simple
		const ta = await thread(f, f.inbox.id, [{ mid: `<exp-a-${tag}@x>`, uid: null }]);
		await moveMail({ ...job([ta.id], f.inbox.id, false), op: "archive", expiresAt: X.toISOString() }, new Map());
		assert(same(await expOf(ta.id, archive.id), X), `a) archive avec echeance, chemin simple : ligne Archive a l'echeance (${await expOf(ta.id, archive.id)})`);

		// b) archive simple d'un fil dont la ligne source portait une echeance
		const tb = await thread(f, f.inbox.id, [{ mid: `<exp-b-${tag}@x>`, uid: null }]);
		await setExp(tb.id, f.inbox.id, X);
		await moveMail({ ...job([tb.id], f.inbox.id, false), op: "archive" }, new Map());
		assert(!!(await threadRow(tb.id, archive.id)) && (await expOf(tb.id, archive.id)) === null, "b) archive sans echeance : ligne Archive sans echeance, meme si la source en portait une");

		// c) collision : le fil a deja sa ligne en Archive (cas Gmail « Tous les messages »)
		const tc = await thread(f, archive.id, [{ mid: `<exp-c0-${tag}@x>`, uid: null }]);
		await addMsg(f, f.inbox.id, tc.id, `<exp-c1-${tag}@x>`);
		await moveMail({ ...job([tc.id], f.inbox.id, false), op: "archive", expiresAt: X.toISOString() }, new Map());
		const rc = await threadRow(tc.id, archive.id);
		assert(rc?.messageCount === 2 && same(rc.expiresAt, X) && !(await threadRow(tc.id, f.inbox.id)), `c) collision : ligne d'arrivee fusionnee, a l'echeance (${rc?.messageCount}, ${rc?.expiresAt})`);

		// c bis) date invalide ou passee : archivage simple
		const tc2 = await thread(f, f.inbox.id, [{ mid: `<exp-c2-${tag}@x>`, uid: null }]);
		await moveMail({ ...job([tc2.id], f.inbox.id, false), op: "archive", expiresAt: PAST.toISOString() }, new Map());
		assert(!!(await threadRow(tc2.id, archive.id)) && (await expOf(tc2.id, archive.id)) === null, "c bis) echeance passee : archive sans echeance");

		// d) move hors Archive (dossier perso, puis retour dans la boite de reception)
		const td = await thread(f, archive.id, [{ mid: `<exp-d-${tag}@x>`, uid: null }]);
		await setExp(td.id, archive.id, X);
		await moveMail({ threadId: td.id, threadIds: [td.id], mailboxId: archive.id, op: "move", toMailboxId: custom.id, moveImap: false, expiresAt: X.toISOString() }, new Map());
		assert(!!(await threadRow(td.id, custom.id)) && (await expOf(td.id, custom.id)) === null, "d) move vers un dossier perso : echeance NULL (expiresAt ignore hors Archive)");
		const td2 = await thread(f, archive.id, [{ mid: `<exp-d2-${tag}@x>`, uid: null }]);
		await setExp(td2.id, archive.id, X);
		await moveMail({ threadId: td2.id, threadIds: [td2.id], mailboxId: archive.id, op: "move", toMailboxId: f.inbox.id, moveImap: false }, new Map());
		assert(!!(await threadRow(td2.id, f.inbox.id)) && (await expOf(td2.id, f.inbox.id)) === null, "d) desarchivage : ligne Inbox sans echeance");

		// f) trigger : etoile sur une ligne a echeance, echeance ecrite sur une ligne etoilee
		const tf = await thread(f, archive.id, [{ mid: `<exp-f-${tag}@x>`, uid: null }]);
		await setExp(tf.id, archive.id, X);
		await db.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, tf.id), eq(mailboxThreads.mailboxId, archive.id)));
		assert((await expOf(tf.id, archive.id)) === null, "f) etoile posee : echeance NULL");
		await setExp(tf.id, archive.id, X);
		assert((await expOf(tf.id, archive.id)) === null, "f) echeance ecrite sur une ligne etoilee : reste NULL");

		// g) message du meme fil dans la boite de reception : echeance de la ligne Archive annulee ;
		//    un message du fil dans les Envoyes ne l'annule pas
		const tg = await thread(f, archive.id, [{ mid: `<exp-g-${tag}@x>`, uid: null }]);
		await setExp(tg.id, archive.id, X);
		await addMsg(f, f.sent.id, tg.id, `<exp-g-sent-${tag}@x>`);
		assert(same(await expOf(tg.id, archive.id), X), "g) message du fil dans les Envoyes : echeance gardee");
		await addMsg(f, f.inbox.id, tg.id, `<exp-g-inbox-${tag}@x>`);
		assert((await expOf(tg.id, archive.id)) === null, "g) message du fil dans la boite de reception : echeance de la ligne Archive NULL");
	}

	// 15 e) MOVE refuse par le serveur pendant un archivage avec echeance : ligne revenue dans la
	//     source, sans echeance (source Inbox, et source dossier perso, ou l'Inbox ne la vide pas).
	for (const src of ["Inbox", "Projets"] as const) {
		const f = await createUserFixture(`expiry-refuse-${src}`);
		const archive = await folderOf(f, "archive", "Archive");
		const from = src === "Inbox" ? f.inbox : await folderOf(f, "custom", "Projets");
		const path = src === "Inbox" ? "INBOX" : "Projets";
		await syncRow(f, from.id, 20);
		await syncRow(f, archive.id, 9);
		const mid = `<exp-e-${src}-${Date.now()}@x>`;
		const imap = new FakeStalwart({ [path]: { uidNext: 21, msgs: [[11, mid]] }, Archive: { uidNext: 10, msgs: [] } });
		imap.refuseMove = true;
		const te = await thread(f, from.id, [{ mid, uid: 11, path }]);
		await expectThrow(
			() => moveMail({ ...job([te.id], from.id, true), op: "archive", expiresAt: X.toISOString() }, on(f, imap)),
			/non deplaces sur IMAP/,
			`e) ${src} : MOVE refuse, le job echoue`,
		);
		const back = await threadRow(te.id, from.id);
		assert(!!back && back.expiresAt === null && !(await threadRow(te.id, archive.id)), `e) ${src} : ligne revenue dans la source, echeance NULL (${back?.expiresAt})`);
	}

	// 15 h) job du tick (expiry: true) sur un fil du : en Corbeille, sur IMAP aussi, echeance NULL ;
	//     messageIds ignore (le fil entier part).
	{
		const f = await createUserFixture("expiry-due");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		await syncRow(f, archive.id, 50);
		await syncRow(f, trash.id, 0);
		const m1 = `<exp-h1-${Date.now()}@x>`;
		const m2 = `<exp-h2-${Date.now()}@x>`;
		const imap = new FakeStalwart({ Archive: { uidNext: 51, msgs: [[40, m1], [41, m2]] }, "Deleted Items": { uidNext: 1, msgs: [] } });
		const th = await thread(f, archive.id, [{ mid: m1, uid: 40, path: "Archive" }, { mid: m2, uid: 41, path: "Archive" }]);
		await setExp(th.id, archive.id, PAST);
		await moveMail({ ...expiryJob([th.id], archive.id, true), messageIds: [th.ids[0]] }, on(f, imap));
		const rows = await msgRows(th.ids);
		assert(rows.length === 2 && rows.every((r) => r.mailboxId === trash.id), "h) fil du : tous ses messages en Corbeille (messageIds ignore)");
		assert(imap.folders.get("Archive")!.msgs.size === 0 && imap.folders.get("Deleted Items")!.msgs.size === 2, "h) fil du : deplace sur IMAP");
		const tr = await threadRow(th.id, trash.id);
		assert(!!tr && tr.expiresAt === null && !(await threadRow(th.id, archive.id)), `h) fil du : ligne en Corbeille, echeance NULL (${tr?.expiresAt})`);
	}

	// 15 i) job du tick sur un fil dont l'echeance a ete videe, future, avec une ligne Inbox soeur,
	//     ou dont la source n'est pas l'Archive : rien ne bouge.
	{
		const f = await createUserFixture("expiry-not-due");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		const tag = Date.now();
		const cleared = await thread(f, archive.id, [{ mid: `<exp-i1-${tag}@x>`, uid: null }]);
		const future = await thread(f, archive.id, [{ mid: `<exp-i2-${tag}@x>`, uid: null }]);
		await setExp(future.id, archive.id, X);
		const sister = await thread(f, archive.id, [{ mid: `<exp-i3-${tag}@x>`, uid: null }]);
		const sisterInbox = await addMsg(f, f.inbox.id, sister.id, `<exp-i3-inbox-${tag}@x>`);
		await setExp(sister.id, archive.id, PAST);
		await moveMail(expiryJob([cleared.id, future.id, sister.id], archive.id, false), new Map());
		const rows = await msgRows([...cleared.ids, ...future.ids, ...sister.ids]);
		assert(rows.every((r) => r.mailboxId === archive.id), "i) echeance videe, future, ou ligne Inbox soeur : rien ne part");
		const [si] = await msgRows([sisterInbox]);
		assert(si.mailboxId === f.inbox.id, "i) le message Inbox du fil reste dans l'Inbox");
		assert(
			!(await threadRow(cleared.id, trash.id)) && !(await threadRow(future.id, trash.id)) && !(await threadRow(sister.id, trash.id)),
			"i) aucune ligne en Corbeille",
		);
		const inboxDue = await thread(f, f.inbox.id, [{ mid: `<exp-i4-${tag}@x>`, uid: null }]);
		await setExp(inboxDue.id, f.inbox.id, PAST);
		await moveMail(expiryJob([inboxDue.id], f.inbox.id, false), new Map());
		const [ri] = await msgRows(inboxDue.ids);
		assert(ri.mailboxId === f.inbox.id, "i) source hors Archive : rien ne part");
	}

	// 15 j) job du tick, MOVE refuse puis partiel : la ligne Archive garde son echeance (sinon le
	//     job rejoue ne trouverait plus rien et le fil resterait en Archive sans echeance, sans
	//     trace), et le job rejoue finit le travail.
	{
		const f = await createUserFixture("expiry-retry");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		await syncRow(f, archive.id, 50);
		await syncRow(f, trash.id, 0);
		const m1 = `<exp-j1-${Date.now()}@x>`;
		const m2 = `<exp-j2-${Date.now()}@x>`;
		const imap = new FakeStalwart({ Archive: { uidNext: 51, msgs: [[40, m1], [41, m2]] }, "Deleted Items": { uidNext: 1, msgs: [] } });
		const tj = await thread(f, archive.id, [{ mid: m1, uid: 40, path: "Archive" }, { mid: m2, uid: 41, path: "Archive" }]);
		await setExp(tj.id, archive.id, PAST);
		imap.refuseMove = true;
		await expectThrow(() => moveMail(expiryJob([tj.id], archive.id, true), on(f, imap)), /2 message\(s\) non deplaces sur IMAP/, "j) MOVE refuse : le job echoue");
		assert(same(await expOf(tj.id, archive.id), PAST), `j) MOVE refuse : la ligne Archive garde son echeance (${await expOf(tj.id, archive.id)})`);
		imap.refuseMove = false;
		imap.skipOnMove.add(41);
		await expectThrow(() => moveMail(expiryJob([tj.id], archive.id, true), on(f, imap)), /1 message\(s\) non deplaces sur IMAP/, "j) MOVE partiel : le job echoue");
		assert(same(await expOf(tj.id, archive.id), PAST), `j) MOVE partiel : la ligne Archive recalculee garde son echeance (${await expOf(tj.id, archive.id)})`);
		assert((await expOf(tj.id, trash.id)) === null, "j) MOVE partiel : la ligne Corbeille n'a pas d'echeance");
		imap.skipOnMove.clear();
		await moveMail(expiryJob([tj.id], archive.id, true), on(f, imap));
		const rows = await msgRows(tj.ids);
		assert(rows.every((r) => r.mailboxId === trash.id) && !(await threadRow(tj.id, archive.id)), "j) job rejoue : le fil est en Corbeille");
	}

	// 15 k) etoile posee pendant le job du tick (entre la verification et la transaction, ou le
	//     worker attend la connexion IMAP) : la transaction revérifie sous verrou, rien ne part.
	{
		const f = await createUserFixture("expiry-race");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		const tk = await thread(f, archive.id, [{ mid: `<exp-k-${Date.now()}@x>`, uid: null }]);
		await setExp(tk.id, archive.id, PAST);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let held!: () => void;
		const holding = new Promise<void>((r) => (held = r));
		const star = db.transaction(async (tx) => {
			await tx.update(mailboxThreads).set({ starred: true }).where(and(eq(mailboxThreads.threadId, tk.id), eq(mailboxThreads.mailboxId, archive.id)));
			held();
			await gate;
		});
		await holding;
		const mv = moveMail(expiryJob([tk.id], archive.id, false), new Map());
		let waited = false;
		for (let i = 0; i < 100 && !waited; i++) {
			const [w] = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
			waited = Number((w as any)?.n) > 0;
			if (!waited) await new Promise((r) => setTimeout(r, 50));
		}
		assert(waited, "k) le job attend le verrou de la ligne etoilee");
		release();
		await star;
		await mv;
		const [rk] = await msgRows(tk.ids);
		assert(rk.mailboxId === archive.id && !(await threadRow(tk.id, trash.id)), "k) etoile posee pendant le job : le fil reste en Archive");
	}

	// 15 l) etoile posee hors de courrier (telephone, Gmail web) sur un fil deja archive : IDLE ne
	//     suit que l'INBOX, la base l'ignore. Le job du tick lit les drapeaux avant le MOVE : le fil
	//     dont un message porte \Flagged reste en Archive, etoile, sans echeance, sans echec du job ;
	//     les autres fils partent. Tous les fils etoiles : aucun MOVE.
	{
		const f = await createUserFixture("expiry-flagged");
		const archive = await folderOf(f, "archive", "Archive");
		const trash = await trashOf(f);
		await syncRow(f, archive.id, 50);
		await syncRow(f, trash.id, 0);
		const m1 = `<exp-l1-${Date.now()}@x>`;
		const m2 = `<exp-l2-${Date.now()}@x>`;
		const m3 = `<exp-l3-${Date.now()}@x>`;
		const m0 = `<exp-l0-${Date.now()}@x>`; // en base seulement : absent du serveur
		const imap = new FakeStalwart({ Archive: { uidNext: 51, msgs: [[40, m1], [41, m2], [42, m3]] }, "Deleted Items": { uidNext: 1, msgs: [] } });
		imap.flagged.add(m2);
		const tl = await thread(f, archive.id, [{ mid: m1, uid: 40, path: "Archive" }, { mid: m2, uid: 41, path: "Archive" }, { mid: m0, uid: 39, path: "Archive" }]);
		const tm = await thread(f, archive.id, [{ mid: m3, uid: 42, path: "Archive" }]);
		await setExp(tl.id, archive.id, PAST);
		await setExp(tm.id, archive.id, PAST);
		await moveMail(expiryJob([tl.id, tm.id], archive.id, true), on(f, imap));
		const rl = await msgRows(tl.ids);
		assert(rl.length === 3 && rl.every((r) => r.mailboxId === archive.id), "l) fil etoile ailleurs : ses messages restent en Archive en base, celui absent du serveur aussi");
		assert(rl.find((r) => r.messageId === m2)?.flagged === true && rl.find((r) => r.messageId === m1)?.flagged === false, "l) fil etoile ailleurs : le message \\Flagged est etoile en base, l'autre non");
		const kept = await threadRow(tl.id, archive.id);
		assert(!!kept && kept.starred === true && kept.expiresAt === null, `l) fil etoile ailleurs : ligne Archive etoilee, echeance NULL (${kept?.starred} ${kept?.expiresAt})`);
		assert(!(await threadRow(tl.id, trash.id)), "l) fil etoile ailleurs : aucune ligne en Corbeille");
		const sv = imap.folders.get("Archive")!.msgs;
		assert(sv.get(40) === m1 && sv.get(41) === m2 && sv.size === 2, "l) fil etoile ailleurs : rien de ce fil deplace sur IMAP");
		const [rm] = await msgRows(tm.ids);
		assert(rm.mailboxId === trash.id && [...imap.folders.get("Deleted Items")!.msgs.values()].includes(m3), "l) l'autre fil du lot part en Corbeille, sur IMAP aussi");

		// Tous les fils du lot etoiles ailleurs : aucun MOVE envoye, le job reussit.
		const m4 = `<exp-l4-${Date.now()}@x>`;
		imap.folders.get("Archive")!.msgs.set(43, m4);
		imap.flagged.add(m4);
		const tn = await thread(f, archive.id, [{ mid: m4, uid: 43, path: "Archive" }]);
		await setExp(tn.id, archive.id, PAST);
		const before = imap.moves;
		await moveMail(expiryJob([tn.id], archive.id, true), on(f, imap));
		assert(imap.moves === before, `l) tous les fils etoiles : aucun MOVE (${imap.moves - before})`);
		const rn = await threadRow(tn.id, archive.id);
		assert(!!rn && rn.starred === true && rn.expiresAt === null && !(await threadRow(tn.id, trash.id)), "l) tous les fils etoiles : fil en Archive, etoile, echeance NULL");
		// Le tick suivant ne le reprend plus.
		assert((await dueExpiredThreads(db, { now: new Date(), mailboxId: archive.id })).every((t) => t.threadId !== tn.id && t.threadId !== tl.id), "l) fils etoiles : plus dus pour le tick");

		// Retour arriere : fil etoile ailleurs et fil non etoile, MOVE refuse. Seul le second compte
		// dans l'echec du job et garde son echeance ; le premier est etoile, sans echeance.
		const m5 = `<exp-l5-${Date.now()}@x>`;
		const m6 = `<exp-l6-${Date.now()}@x>`;
		imap.folders.get("Archive")!.msgs.set(44, m5);
		imap.folders.get("Archive")!.msgs.set(45, m6);
		imap.flagged.add(m5);
		const tp = await thread(f, archive.id, [{ mid: m5, uid: 44, path: "Archive" }]);
		const tq = await thread(f, archive.id, [{ mid: m6, uid: 45, path: "Archive" }]);
		await setExp(tp.id, archive.id, PAST);
		await setExp(tq.id, archive.id, PAST);
		imap.refuseMove = true;
		await expectThrow(() => moveMail(expiryJob([tp.id, tq.id], archive.id, true), on(f, imap)), /1 message\(s\) non deplaces sur IMAP/, "l) MOVE refuse : seul le fil non etoile fait echouer le job");
		imap.refuseMove = false;
		const rp = await threadRow(tp.id, archive.id);
		assert(!!rp && rp.starred === true && rp.expiresAt === null && !(await threadRow(tp.id, trash.id)), "l) MOVE refuse : fil etoile ailleurs en Archive, etoile, echeance NULL");
		assert(same(await expOf(tq.id, archive.id), PAST) && !(await threadRow(tq.id, trash.id)), `l) MOVE refuse : l'autre fil revient en Archive avec son echeance (${await expOf(tq.id, archive.id)})`);
	}
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
