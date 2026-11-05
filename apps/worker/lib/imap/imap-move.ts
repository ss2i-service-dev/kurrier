import { db, mailboxes, mailboxSync, messages, mailboxThreads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { initSmtpClient } from "./imap-client";
import {
	planMessageMove,
	cursorAtTop,
	destCursorAfterMove,
	heldUids,
	knownArrivals,
	matchMovedUids,
	normMessageId,
	shouldMoveImap,
	type DestEnvelope,
} from "@common";
import { resolveUids, type UidRow } from "./imap-resolve-uids";

type MoveJob = {
	threadId: string;
	// A whole selection in a single job (database updated for all threads, then one IMAP MOVE per
	// folder). One job per thread, processed one by one, left the selection on screen for long
	// seconds on Gmail.
	threadIds?: string[];
	mailboxId: string; // source
	op: "trash" | "archive" | "spam" | "move";
	toMailboxId?: string; // required when op === "move"
	moveImap: boolean;
	messageId?: string;
	// When provided, only these messages move (sender blocking); a thread left with no other
	// message in the source folder moves entirely. Without it (all existing callers), the whole
	// thread moves. `messageId` stays ignored.
	messageIds?: string[];
};

export const moveMail = async (
	data: MoveJob,
	imapInstances: Map<string, ImapFlow>,
) => {
	const {
		threadId,
		threadIds: batchIds,
		mailboxId: fromMailboxId,
		op,
		toMailboxId,
	} = data;

	const ids = (batchIds?.length ? batchIds : [threadId]).map(String).filter(Boolean);
	if (!ids.length) return;

	// Source mailbox
	const [srcMailbox] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, fromMailboxId));
	if (!srcMailbox) return;

	// Destination mailbox
	let destMailboxRow: typeof mailboxes.$inferSelect | undefined;

	if (op === "move") {
		if (!toMailboxId || toMailboxId === fromMailboxId) return;
		[destMailboxRow] = await db
			.select()
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.id, toMailboxId),
					eq(mailboxes.identityId, srcMailbox.identityId),
				),
			);
	} else {
		[destMailboxRow] = await db
			.select()
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.identityId, srcMailbox.identityId),
					eq(mailboxes.kind, op as any),
				),
			);
	}

	if (!destMailboxRow) {
		console.warn(
			`[mail:move] No destination for op=${op} identity=${srcMailbox.identityId}`,
		);
		return;
	}

	// "Trash -> Trash" (Delete clicked from the trash) has nothing to move.
	if (destMailboxRow.id === fromMailboxId) return;

	const destPath: string =
		(destMailboxRow.metaData as any)?.imap?.path ?? destMailboxRow.name;

	// Messages in thread scoped to the source mailbox
	const threadMsgs = await db
		.select({
			id: messages.id,
			meta: messages.metaData,
			messageId: messages.messageId,
			threadId: messages.threadId,
		})
		.from(messages)
		.where(
			and(
				inArray(messages.threadId, ids),
				eq(messages.mailboxId, fromMailboxId),
			),
		);
	if (threadMsgs.length === 0) return;

	// Message granularity: only the requested messages are moved.
	const plan = data.messageIds?.length
		? planMessageMove(threadMsgs, data.messageIds)
		: null;
	if (plan && !plan.messageIds.length) return;
	const movingIds = plan ? new Set(plan.messageIds) : null;
	const toMove = movingIds ? threadMsgs.filter((m) => movingIds.has(m.id)) : threadMsgs;

	// The IMAP MOVE does not depend on what the page loaded (see shouldMoveImap): a folder
	// synced over IMAP is always moved on the server.
	const [srcSync] = await db
		.select({ id: mailboxSync.id })
		.from(mailboxSync)
		.where(eq(mailboxSync.mailboxId, fromMailboxId))
		.limit(1);
	const moveImap = shouldMoveImap(data.moveImap, !!srcSync);
	if (moveImap && !data.moveImap) {
		console.info(
			`[mail:move] folder ${fromMailboxId} is synced over IMAP: IMAP MOVE done ("database only" request ignored)`,
		);
	}

	// Collect BEFORE the database update, which rewrites imap.mailboxPath.
	type Group = { path: string; rows: UidRow[] };
	const byPath = new Map<string, Group>();
	if (moveImap) {
		for (const m of toMove) {
			const im = (m.meta as any)?.imap;
			const uid = im?.uid as number | undefined;
			const srcPath = im?.mailboxPath as string | undefined;
			if (!uid || !srcPath) continue;
			const g = byPath.get(srcPath) ?? { path: srcPath, rows: [] };
			g.rows.push({ id: m.id, uid: Number(uid), messageId: m.messageId });
			byPath.set(srcPath, g);
		}
	}

	// IMAP client checked BEFORE the database. Otherwise the database would be updated and
	// the job would stop there: the database saying "Archive", the server "INBOX". The job
	// fails without changing anything and BullMQ retries it.
	let client: ImapFlow | undefined;
	if (moveImap && byPath.size) {
		client = await initSmtpClient(srcMailbox.identityId, imapInstances);
		if (!client?.authenticated || !client.usable) {
			throw new Error(
				`[mail:move] IMAP unavailable for identity ${srcMailbox.identityId}: nothing moved, neither in the database nor on the server`,
			);
		}
	}

	// Database first, IMAP second. The other way round, the thread would stay in place in the
	// UI during the whole IMAP round trip (several seconds on Gmail), and an EXPUNGE received by
	// the realtime connection could delete the row before it was moved. What the server did not
	// move is put back in the source folder in the database (moveGroupOnImap), instead of
	// letting the database lie.
	const dupIds = new Set<string>();
	await db.transaction(async (tx) => {
		// Copy already present at the destination (same Message-ID: message sent to self, Sent
		// copy already filed there): the unique index (mailbox_id, message_id) would make the whole
		// job fail. The source row is deleted in the database, the destination copy stands for it;
		// its UID stays in the IMAP MOVE (byPath) and the destination UID counts as known for the
		// cursor.
		const mids = [...new Set(toMove.map((m) => m.messageId).filter(Boolean) as string[])];
		for (const part of chunks(mids, CHUNK)) {
			const there = new Set(
				(
					await tx
						.select({ messageId: messages.messageId })
						.from(messages)
						.where(and(eq(messages.mailboxId, destMailboxRow.id), inArray(messages.messageId, part)))
				).map((r) => r.messageId),
			);
			for (const m of toMove) if (m.messageId && there.has(m.messageId)) dupIds.add(m.id);
		}
		if (dupIds.size) {
			for (const part of chunks([...dupIds], CHUNK)) {
				await tx.delete(messages).where(inArray(messages.id, part));
			}
			console.info(
				`[mail:move] ${dupIds.size} message(s) already in ${destPath} (same Message-ID): source row deleted in the database, IMAP copy moved`,
			);
		}

		const set: Record<string, any> = {
			mailboxId: destMailboxRow.id,
			updatedAt: new Date(),
		};
		if (moveImap) {
			// The source UID goes away with the folder change (it was collected beforehand, in
			// byPath); a worker stop between this transaction and the UID copy-back would otherwise
			// leave a source UID on a destination path.
			set.metaData = sql`
        jsonb_set(
          coalesce(${messages.metaData}, '{}'::jsonb),
          '{imap,mailboxPath}',
          to_jsonb(${destPath}::text),
          true
        ) #- '{imap,uid}'
      `;
		}

		await tx
			.update(messages)
			.set(set)
			.where(
				plan
					? and(inArray(messages.id, plan.messageIds), eq(messages.mailboxId, fromMailboxId))
					: and(
							inArray(messages.threadId, ids),
							eq(messages.mailboxId, fromMailboxId),
						),
			);

		if (plan) {
			// Thread summaries are per folder: the destination's are recomputed, the source's too
			// (partial thread) or deleted (thread moved entirely).
			for (const threadId of [...plan.fullThreadIds, ...plan.partialThreadIds]) {
				await refreshThreadIn(tx, threadId, destMailboxRow.id);
				await refreshThreadIn(tx, threadId, fromMailboxId);
			}
			return;
		}

		// A thread that already has a row in the destination folder (key thread_id + mailbox_id)
		// would make the WHOLE job fail. Those threads are merged into the existing row, the
		// others change folder normally.
		const clash = new Set(
			(
				await tx
					.select({ threadId: mailboxThreads.threadId })
					.from(mailboxThreads)
					.where(
						and(
							inArray(mailboxThreads.threadId, ids),
							eq(mailboxThreads.mailboxId, destMailboxRow.id),
						),
					)
			).map((r) => r.threadId),
		);
		const plain = ids.filter((t) => !clash.has(t));
		if (plain.length) {
			await tx
				.update(mailboxThreads)
				.set({
					mailboxId: destMailboxRow.id,
					mailboxSlug: op === "move" ? (destMailboxRow.slug ?? "custom") : op,
					updatedAt: new Date(),
				})
				.where(
					and(
						inArray(mailboxThreads.threadId, plain),
						eq(mailboxThreads.mailboxId, fromMailboxId),
					),
				);
		}
		for (const t of clash) {
			await tx
				.delete(mailboxThreads)
				.where(and(eq(mailboxThreads.threadId, t), eq(mailboxThreads.mailboxId, fromMailboxId)));
		}
		// Merged threads, and threads from which a copy was deleted (counters to redo).
		const dupThreads = toMove.filter((m) => dupIds.has(m.id)).map((m) => m.threadId);
		for (const t of new Set([...clash, ...dupThreads])) {
			await refreshThreadIn(tx, t, destMailboxRow.id);
		}
	});

	if (!moveImap) return;
	if (!byPath.size || !client) {
		console.debug(
			"[mail:move] No IMAP-backed UIDs to move; DB-only move was applied.",
		);
		return;
	}

	const ctx: MoveCtx = {
		src: srcMailbox,
		dest: destMailboxRow,
		destPath,
		movingIds: new Set(toMove.map((m) => m.id)),
		dupIds,
		threadOf: new Map(toMove.map((m) => [m.id, m.threadId])),
	};
	let reverted = 0;
	for (const g of byPath.values()) reverted += await moveGroupOnImap(client, g, ctx);
	if (reverted) {
		// The job fails (so BullMQ retries it): the messages put back in the source will be moved again.
		throw new Error(
			`[mail:move] ${reverted} message(s) not moved over IMAP (${srcMailbox.name} -> ${destPath}), put back in ${srcMailbox.name} in the database`,
		);
	}
};

// Chunks: Postgres refuses more than 65,534 parameters per query, and a single job can
// carry tens of thousands of messages.
const CHUNK = 10_000;
function chunks<T>(list: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
	return out;
}

type MoveCtx = {
	src: typeof mailboxes.$inferSelect;
	dest: typeof mailboxes.$inferSelect;
	destPath: string;
	movingIds: Set<string>;
	// Messages with a copy (same Message-ID) already at the destination: source row deleted
	// in the transaction, nothing to put back in the source.
	dupIds: Set<string>;
	threadOf: Map<string, string>;
};

/**
 * IMAP MOVE of one source folder, under ONE connection lock (no sync can interleave):
 * 1. resolveUids (real UIDs in the source, verified by Message-ID); whatever it does not
 *    find is not sent and is put back in the source in the database;
 * 2. UIDNEXT of the destination folder (STATUS) and deltaFetch cursor read;
 * 3. UID MOVE; imapflow returns false on a refusal, without throwing or logging: we report it;
 * 4. re-read of the destination folder (EXAMINE, UID >= the previous UIDNEXT) and UIDs copied
 *    back by Message-ID (matchMovedUids), never by position in the COPYUID, which Stalwart
 *    permutes; cursor set in one compare-and-set;
 * 5. what was sent but did not arrive is looked up in the source at its UID: if it is there,
 *    it is put back in the source folder in the database (the server did not move it); if it
 *    is nowhere, it stays at the destination without a UID.
 * Returns the number of messages put back in the source.
 */
async function moveGroupOnImap(
	client: ImapFlow,
	g: { path: string; rows: UidRow[] },
	ctx: MoveCtx,
): Promise<number> {
	const { path: srcPath, rows } = g;
	const tag = `${ctx.src.identityId} ${srcPath} -> ${ctx.destPath}`;
	const rowById = new Map(rows.map((r) => [r.id, r]));
	const isDup = (id: string) => ctx.dupIds.has(id);
	const settled = new Set<string>();
	const srcUid = new Map<string, number>();
	let state: "before" | "sent" | "done" | "refused" = "before";
	let reverted = 0;

	let lock: { release: () => void };
	try {
		lock = await client.getMailboxLock(srcPath);
	} catch (err) {
		console.error(`[mail:move] source folder unreadable (${tag}): ${rows.length} message(s) put back in the source in the database`, err);
		return await revertToSource(
			rows.filter((r) => !isDup(r.id)).map((r) => ({ id: r.id, uid: r.uid })),
			srcPath,
			ctx,
		);
	}
	try {
		const wanted = await resolveUids(client, rows);
		for (const [uid, id] of wanted) if (!srcUid.has(id)) srcUid.set(id, uid);

		// Never sent in the MOVE: resolveUids did not find them in the source (stale UID that
		// Stalwart cannot find: empty SEARCH HEADER, scan bounded to 5,000 messages; or read
		// error). The server did not move them: put back in the source in the database, without
		// re-reading their database UID, which may designate another message.
		const notSent = rows.filter((r) => !srcUid.has(r.id));
		if (notSent.length) {
			const back = notSent.filter((r) => !isDup(r.id));
			reverted += await revertToSource(back.map((r) => ({ id: r.id, uid: r.uid })), srcPath, ctx);
			notSent.forEach((r) => settled.add(r.id));
			console.error(
				`[mail:move] ${notSent.length} message(s) not found in ${srcPath} by UID or Message-ID (${tag}): not sent in the MOVE, ${back.length} put back in the source folder in the database`,
				notSent.slice(0, 20).map((r) => r.id),
			);
		}

		let toCheck: string[] = [];
		if (wanted.size) {
			const st = await client.status(ctx.destPath, { uidNext: true });
			const u0 = Number((st && st.uidNext) || 0);
			if (!u0) throw new Error(`UIDNEXT of ${ctx.destPath} unreadable (STATUS)`);
			const cursor = await readDestCursor(ctx.dest.id);

			state = "sent";
			const moved = await client.messageMove([...wanted.keys()], ctx.destPath, { uid: true });
			state = moved ? "done" : "refused";
			if (!moved) {
				console.error(`[mail:move] UID MOVE refused by the server (${tag}), ${wanted.size} UID`);
			}

			const box = await client.mailboxOpen(ctx.destPath, { readOnly: true });
			// Gmail: a message already present at the destination ("All Mail") keeps its UID, lower
			// than UIDNEXT; the COPYUID one is re-read too, then verified by Message-ID.
			const copyUids = moved && moved.uidMap ? [...moved.uidMap.values()] : [];
			const found = await readArrived(client, Number(box?.exists ?? 0), u0, copyUids);

			const sentIds = [...new Set(wanted.values())];
			const movedRows = sentIds.filter((id) => !isDup(id)).map((id) => rowById.get(id)!);
			const taken = heldUids(found, await heldInDest(ctx, found));
			const m = matchMovedUids(movedRows, found, taken);
			await setUids([...m.assigned], ctx.dest.id);
			for (const id of m.assigned.keys()) settled.add(id);
			if (m.ambiguous.length) {
				m.ambiguous.forEach((id) => settled.add(id));
				console.warn(
					`[mail:move] ${m.ambiguous.length} message(s) with a duplicated Message-ID at the destination (${tag}): left without a UID`,
					m.ambiguous.slice(0, 20),
				);
			}

			// Copies deleted in the database (dupIds): nothing to put back; only report whether the
			// server did not move them (they stay in the source with no database row).
			const dupSent = sentIds.filter(isDup);
			if (dupSent.length) {
				dupSent.forEach((id) => settled.add(id));
				const arrivedMids = new Set(found.filter((f) => f.uid >= u0).map((f) => normMessageId(f.messageId)));
				const lost = dupSent.filter((id) => !arrivedMids.has(normMessageId(rowById.get(id)!.messageId)));
				if (lost.length) {
					console.error(
						`[mail:move] ${lost.length} copy(ies) already present at the destination not moved by the server (${tag}): left in ${srcPath}, without a database row`,
						lost.slice(0, 20),
					);
				}
			}

			if (cursor && cursorAtTop(cursor.l0, u0)) {
				const known = knownArrivals(
					found,
					sentIds.map((id) => rowById.get(id)!.messageId),
					[...taken, ...m.assigned.values()],
				);
				const target = destCursorAfterMove(
					u0,
					found.map((f) => ({ uid: f.uid, known: known.has(f.uid) })),
				);
				if (target !== cursor.l0 && !(await casCursor(cursor.id, cursor.l0, target))) {
					console.warn(`[mail:move] cursor ${cursor.id} changed during the move (expected ${cursor.l0}), left as is`);
				}
			}
			toCheck = m.missing;
		}

		if (toCheck.length) {
			// Sent but not arrived: does the server still have it in the source, at the UID that
			// resolveUids verified there?
			await client.mailboxOpen(srcPath, { readOnly: true });
			const uidOf = (id: string) => srcUid.get(id)!;
			const atSrc = await envelopesAt(client, toCheck.map(uidOf));
			const back: Array<{ id: string; uid: number }> = [];
			const nowhere: string[] = [];
			for (const id of toCheck) {
				const mid = atSrc.get(uidOf(id));
				if (mid !== undefined && mid === normMessageId(rowById.get(id)!.messageId)) {
					back.push({ id, uid: uidOf(id) });
				} else {
					nowhere.push(id);
				}
			}
			if (back.length) {
				reverted += await revertToSource(back, srcPath, ctx);
				back.forEach((b) => settled.add(b.id));
				console.error(
					`[mail:move] ${back.length} message(s) still in ${srcPath} on the server (${tag}): put back in the source folder in the database`,
					back.slice(0, 20).map((b) => b.id),
				);
			}
			if (nowhere.length) {
				nowhere.forEach((id) => settled.add(id));
				console.warn(
					`[mail:move] ${nowhere.length} message(s) in neither the source nor the arrived batch (${tag}): left at the destination without a UID`,
					nowhere.slice(0, 20),
				);
			}
		}
	} catch (err) {
		const rest = rows.filter((r) => !settled.has(r.id) && !isDup(r.id));
		// Server that answered OK to the MOVE: these messages are at the destination, UID unknown
		// (already removed in the database). Otherwise (refusal, disconnect before or during the
		// MOVE): put back in the source.
		const arrived = state === "done" ? rest.filter((r) => srcUid.has(r.id)) : [];
		const back = rest.filter((r) => !arrived.includes(r));
		console.error(
			`[mail:move] IMAP error (${tag}, step ${state}): ${back.length} message(s) put back in the source in the database, ${arrived.length} left at the destination without a UID`,
			err,
		);
		reverted += await revertToSource(
			back.map((r) => ({ id: r.id, uid: srcUid.get(r.id) ?? r.uid })),
			srcPath,
			ctx,
		);
	} finally {
		lock.release();
	}
	return reverted;
}

// Envelopes of the open folder: UID >= u0 (arrived from the MOVE) and COPYUID UIDs below u0.
async function readArrived(
	client: ImapFlow,
	exists: number,
	u0: number,
	copyUids: number[],
): Promise<DestEnvelope[]> {
	const out = new Map<number, string | null>();
	if (exists > 0) {
		// "u0:*" also returns the last message when nothing is above it: filter.
		for await (const m of client.fetch(`${u0}:*`, { uid: true, envelope: true }, { uid: true })) {
			if (Number(m.uid) >= u0) out.set(Number(m.uid), m.envelope?.messageId ?? null);
		}
		const extra = [...new Set(copyUids.map(Number))].filter((u) => u > 0 && u < u0);
		for (const part of chunks(extra, 500)) {
			for await (const m of client.fetch(part.join(","), { uid: true, envelope: true }, { uid: true })) {
				out.set(Number(m.uid), m.envelope?.messageId ?? null);
			}
		}
	}
	return [...out].map(([uid, messageId]) => ({ uid, messageId }));
}

// UID -> normalized Message-ID, for UIDs of the open folder (absent: not in the Map).
async function envelopesAt(client: ImapFlow, uids: number[]) {
	const out = new Map<number, string>();
	const list = [...new Set(uids.map(Number))].filter((u) => u > 0);
	for (const part of chunks(list, 500)) {
		for await (const m of client.fetch(part.join(","), { uid: true, envelope: true }, { uid: true })) {
			out.set(Number(m.uid), normMessageId(m.envelope?.messageId));
		}
	}
	return out;
}

// Messages of the destination folder (outside the job) that already hold one of these UIDs
// in the database. In chunks (parameter limit), the job's own messages dropped here rather
// than in SQL.
async function heldInDest(ctx: MoveCtx, found: DestEnvelope[]): Promise<DestEnvelope[]> {
	const uidText = sql<string>`${messages.metaData}->'imap'->>'uid'`;
	const out: DestEnvelope[] = [];
	for (const part of chunks(found.map((f) => String(f.uid)), CHUNK)) {
		const rows = await db
			.select({ id: messages.id, uid: uidText, messageId: messages.messageId })
			.from(messages)
			.where(and(eq(messages.mailboxId, ctx.dest.id), inArray(uidText, part)));
		for (const r of rows) if (!ctx.movingIds.has(r.id)) out.push({ uid: Number(r.uid), messageId: r.messageId });
	}
	return out;
}

// Destination UIDs copied back to the database: one UPDATE per chunk (not per message),
// since the connection's IMAP lock is held meanwhile.
async function setUids(pairs: Array<[string, number]>, mailboxId: string) {
	for (const part of chunks(pairs, 1000)) {
		await db.execute(sql`
			update messages
			set meta = jsonb_set(coalesce(messages.meta, '{}'::jsonb), '{imap,uid}', to_jsonb(v.uid), true)
			from (values ${sql.join(
				part.map(([id, uid]) => sql`(${id}::uuid, ${Number(uid)}::bigint)`),
				sql`, `,
			)}) as v(id, uid)
			where messages.id = v.id and messages.mailbox_id = ${mailboxId}::uuid
		`);
	}
}

// Puts back in the source folder, in the database, messages the server did not move
// (source path and UID), then recomputes the thread rows of both folders.
async function revertToSource(
	items: Array<{ id: string; uid: number }>,
	srcPath: string,
	ctx: MoveCtx,
): Promise<number> {
	if (!items.length) return 0;
	let n = 0;
	await db.transaction(async (tx) => {
		for (const part of chunks(items, 1000)) {
			const res = await tx.execute(sql`
				update messages
				set mailbox_id = ${ctx.src.id}::uuid,
				    updated_at = now(),
				    meta = jsonb_set(
				      jsonb_set(coalesce(messages.meta, '{}'::jsonb), '{imap,mailboxPath}', to_jsonb(${srcPath}::text), true),
				      '{imap,uid}', to_jsonb(v.uid), true)
				from (values ${sql.join(
					part.map((it) => sql`(${it.id}::uuid, ${Number(it.uid)}::bigint)`),
					sql`, `,
				)}) as v(id, uid)
				where messages.id = v.id and messages.mailbox_id = ${ctx.dest.id}::uuid
				returning messages.id
			`);
			n += (res as unknown as unknown[]).length;
		}
		const threadIds = [...new Set(items.map((it) => ctx.threadOf.get(it.id)))].filter(Boolean) as string[];
		for (const t of threadIds) await resettleThread(tx, t, ctx.dest, ctx.src);
	});
	return n;
}

// mailbox_threads row of a thread in a folder: recomputed if a message of the thread
// remains there, deleted otherwise.
async function refreshThreadIn(tx: any, threadId: string, mailboxId: string) {
	const [one] = await tx
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.threadId, threadId), eq(messages.mailboxId, mailboxId)))
		.limit(1);
	if (one) {
		await upsertMailboxThreadItem(one.id, tx);
	} else {
		await tx
			.delete(mailboxThreads)
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, mailboxId)));
	}
}

// mailbox_threads rows of a thread whose messages have just gone back from `from` to `to`.
// Thread fully back: its row comes back with it (snooze carry-over kept); then both rows
// are recomputed, deleting that of a folder left without a message of the thread.
async function resettleThread(
	tx: any,
	threadId: string,
	from: typeof mailboxes.$inferSelect,
	to: typeof mailboxes.$inferSelect,
) {
	const has = async (mailboxId: string) =>
		(
			await tx
				.select({ id: messages.id })
				.from(messages)
				.where(and(eq(messages.threadId, threadId), eq(messages.mailboxId, mailboxId)))
				.limit(1)
		).length > 0;
	if (!(await has(to.id))) return;
	const [toRow] = await tx
		.select({ threadId: mailboxThreads.threadId })
		.from(mailboxThreads)
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, to.id)))
		.limit(1);
	if (!toRow && !(await has(from.id))) {
		await tx
			.update(mailboxThreads)
			.set({ mailboxId: to.id, mailboxSlug: to.slug ?? null, updatedAt: new Date() })
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, from.id)));
	}
	await refreshThreadIn(tx, threadId, to.id);
	await refreshThreadIn(tx, threadId, from.id);
}

// deltaFetch cursor of the destination folder (see cursorAtTop / destCursorAfterMove): read
// before the MOVE, set once at the end of the operation, in compare-and-set from that
// value. All under the lock of the IMAP connection that deltaFetch shares (imapInstances):
// it neither reads nor writes this cursor during the move.
async function readDestCursor(mailboxId: string) {
	const [s] = await db
		.select({ id: mailboxSync.id, lastSeenUid: mailboxSync.lastSeenUid })
		.from(mailboxSync)
		.where(eq(mailboxSync.mailboxId, mailboxId))
		.limit(1);
	return s ? { id: s.id, l0: Number(s.lastSeenUid ?? 0) } : null;
}

async function casCursor(id: string, from: number, to: number) {
	const r = await db
		.update(mailboxSync)
		.set({ lastSeenUid: to, updatedAt: new Date() })
		.where(and(eq(mailboxSync.id, id), eq(mailboxSync.lastSeenUid, from)))
		.returning({ id: mailboxSync.id });
	return r.length === 1;
}
