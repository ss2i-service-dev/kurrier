// moveMail de bout en bout (OI 10286) sur une base de test, avec un faux serveur IMAP qui se
// comporte comme Stalwart : COPYUID permute, SEARCH HEADER Message-ID vide, balayage impossible
// au-dela de 5 000 messages, MOVE refuse (false sans erreur) ou partiel. Verifie : UID recopies
// par Message-ID (par tranches), curseur deltaFetch du dossier d'arrivee (ecrit une fois, apres
// le MOVE, doublons compris), mise a la corbeille IMAP meme quand la page dit « base seule »,
// collisions de cle (mailbox_threads, et messages : meme Message-ID deja a l'arrivee) sans perte
// des autres fils, UID retire des la transaction, retour en base de ce que le serveur n'a pas
// deplace (y compris ce qui n'a jamais ete envoye), IMAP indisponible = rien ne bouge, lot de
// plus de 65 534 UID arrives, et deltaFetch qui ne supprime plus la copie des Envoyes.
// Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55436/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/move-imap.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { moveMail } from "../lib/imap/imap-move";
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
	async search() {
		return []; // Stalwart ne rend rien sur SEARCH HEADER Message-ID
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
				flags: new Set<string>(["\\Seen"]),
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

async function folderOf(f: Fixture, kind: "archive" | "spam", name: string) {
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

const on = (f: Fixture, imap: FakeStalwart) => new Map([[f.identity.id, imap as unknown as ImapFlow]]);

async function syncRow(f: Fixture, mailboxId: string, lastSeenUid: number) {
	await db.insert(mailboxSync).values({ identityId: f.identity.id, mailboxId, uidValidity: BigInt(1), lastSeenUid });
}

async function cursorOf(mailboxId: string) {
	const [r] = await db.select().from(mailboxSync).where(eq(mailboxSync.mailboxId, mailboxId));
	return Number(r.lastSeenUid);
}

// Un fil de messages dans `mailboxId` ; uid null = message sans UID IMAP.
async function thread(f: Fixture, mailboxId: string, items: Array<{ mid: string; uid: number | null; path?: string }>) {
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
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
