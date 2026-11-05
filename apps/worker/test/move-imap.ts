// moveMail de bout en bout (OI 10286) sur une base de test, avec un faux serveur IMAP qui se
// comporte comme Stalwart : COPYUID permute, SEARCH HEADER Message-ID vide, MOVE refuse (false
// sans erreur) ou partiel. Verifie : UID recopies par Message-ID, curseur deltaFetch du dossier
// d'arrivee, mise a la corbeille IMAP meme quand la page dit « base seule », collision de cle
// mailbox_threads sans perte des autres fils, retour en base de ce que le serveur n'a pas
// deplace, et IMAP indisponible = rien ne bouge. Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55436/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/move-imap.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, mailboxes, mailboxSync, mailboxThreads, messages, threads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { moveMail } from "../lib/imap/imap-move";

type Fixture = Awaited<ReturnType<typeof createUserFixture>>;
type Folder = { uidNext: number; msgs: Map<number, string | null> };

class FakeStalwart {
	authenticated = true;
	usable = true;
	refuseMove = false;
	skipOnMove = new Set<number>(); // UID que le serveur « oublie » en repondant OK
	moves = 0;
	selected = "";
	folders = new Map<string, Folder>();
	constructor(init: Record<string, { uidNext: number; msgs: Array<[number, string | null]> }>) {
		for (const [p, f] of Object.entries(init)) this.folders.set(p, { uidNext: f.uidNext, msgs: new Map(f.msgs) });
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
		return []; // Stalwart ne rend rien sur SEARCH HEADER Message-ID
	}
	async *fetch(range: string) {
		const f = this.folders.get(this.selected)!;
		const all = [...f.msgs.keys()].sort((a, b) => a - b);
		let pick: number[];
		if (range.endsWith(":*")) {
			const a = Number(range.split(":")[0]);
			pick = all.filter((u) => u >= a);
			if (!pick.length && all.length) pick = [all[all.length - 1]];
		} else {
			pick = range.split(",").map(Number).filter((u) => f.msgs.has(u));
		}
		for (const uid of pick) yield { uid, envelope: { messageId: f.msgs.get(uid) ?? undefined } };
	}
	async messageMove(uids: number[], dest: string) {
		this.moves++;
		if (this.refuseMove) return false;
		const s = this.folders.get(this.selected)!;
		const d = this.folders.get(dest)!;
		const present = uids.filter((u) => s.msgs.has(u) && !this.skipOnMove.has(u)).sort((a, b) => a - b);
		const destUids: number[] = [];
		for (const u of present) {
			const nu = d.uidNext++;
			d.msgs.set(nu, s.msgs.get(u)!);
			s.msgs.delete(u);
			destUids.push(nu);
		}
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
		await moveMail(job([t1.id, t2.id], f.inbox.id, false), new Map([[f.identity.id, imap as unknown as ImapFlow]]));

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

	// 4. MOVE partiel (OK du serveur, un message reste dans la source) et message introuvable.
	{
		const f = await createUserFixture("move-partiel");
		const trash = await trashOf(f);
		await syncRow(f, f.inbox.id, 40);
		await syncRow(f, trash.id, 4);
		const mids = [`<p1-${Date.now()}@x>`, `<p2-${Date.now()}@x>`, `<p3-${Date.now()}@x>`];
		const imap = new FakeStalwart({
			INBOX: { uidNext: 41, msgs: [[31, mids[0]], [32, mids[1]]] }, // p3 n'est plus sur le serveur
			"Deleted Items": { uidNext: 5, msgs: [] },
		});
		imap.skipOnMove.add(32);
		const t6 = await thread(f, f.inbox.id, mids.map((mid, i) => ({ mid, uid: 31 + i })));
		await expectThrow(
			() => moveMail(job([t6.id], f.inbox.id, true), new Map([[f.identity.id, imap as unknown as ImapFlow]])),
			/1 message\(s\) non deplaces sur IMAP/,
			"MOVE partiel : le job echoue pour le message reste dans la source",
		);
		const rows = new Map((await msgRows(t6.ids)).map((r) => [r.messageId, r]));
		const p1 = rows.get(mids[0])!;
		const p2 = rows.get(mids[1])!;
		const p3 = rows.get(mids[2])!;
		assert(p1.mailboxId === trash.id && (p1.metaData as any).imap.uid === 5, "MOVE partiel : message arrive, UID d'arrivee 5");
		assert(p2.mailboxId === f.inbox.id && (p2.metaData as any).imap.uid === 32, "MOVE partiel : message reste sur le serveur remis dans l'Inbox (UID 32)");
		assert(p3.mailboxId === trash.id && (p3.metaData as any).imap.uid === undefined, "message introuvable partout : en corbeille, sans UID");
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
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
