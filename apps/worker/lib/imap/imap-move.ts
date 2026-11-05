import { db, mailboxes, mailboxSync, messages, mailboxThreads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { initSmtpClient } from "./imap-client";
import {
	planMessageMove,
	destCursorAfterMove,
	destCursorBeforeMove,
	heldUids,
	matchMovedUids,
	normMessageId,
	shouldMoveImap,
	type DestEnvelope,
} from "@common";
import { resolveUids, type UidRow } from "./imap-resolve-uids";

type MoveJob = {
	threadId: string;
	// ss2i : une selection entiere en un seul job (base mise a jour pour tous les fils,
	// puis un MOVE IMAP par dossier). Un job par fil, traites un a un, laissait la
	// selection a l'ecran pendant de longues secondes chez Gmail.
	threadIds?: string[];
	mailboxId: string; // source
	op: "trash" | "archive" | "spam" | "move";
	toMailboxId?: string; // required when op === "move"
	moveImap: boolean;
	messageId?: string;
	// ss2i : quand il est fourni, seuls ces messages bougent (blocage d'expediteur) ; un fil
	// qui n'a plus aucun autre message dans le dossier source part en entier. Sans lui (tous
	// les appels existants), c'est le fil entier, comme avant. `messageId` reste ignore.
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

	// ss2i : « corbeille -> corbeille » (Delete clique depuis la corbeille) n'a rien a deplacer.
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

	// Grain du message : seuls les messages demandes sont deplaces.
	const plan = data.messageIds?.length
		? planMessageMove(threadMsgs, data.messageIds)
		: null;
	if (plan && !plan.messageIds.length) return;
	const movingIds = plan ? new Set(plan.messageIds) : null;
	const toMove = movingIds ? threadMsgs.filter((m) => movingIds.has(m.id)) : threadMsgs;

	// ss2i (OI 10286) : le MOVE IMAP ne depend plus de ce que la page a charge (cf. shouldMoveImap) :
	// un dossier synchronise en IMAP est toujours deplace sur le serveur.
	const [srcSync] = await db
		.select({ id: mailboxSync.id })
		.from(mailboxSync)
		.where(eq(mailboxSync.mailboxId, fromMailboxId))
		.limit(1);
	const moveImap = shouldMoveImap(data.moveImap, !!srcSync);
	if (moveImap && !data.moveImap) {
		console.info(
			`[mail:move] dossier ${fromMailboxId} synchronise en IMAP : MOVE IMAP fait (demande « base seule » ignoree)`,
		);
	}

	// A relever AVANT la mise a jour en base, qui reecrit imap.mailboxPath.
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

	// ss2i (OI 10286) : client IMAP verifie AVANT la base. Sans lui, on mettait la base a jour
	// puis on s'arretait la : la base disait « Archive », le serveur « INBOX ». Le job echoue
	// sans rien changer et BullMQ le rejoue.
	let client: ImapFlow | undefined;
	if (moveImap && byPath.size) {
		client = await initSmtpClient(srcMailbox.identityId, imapInstances);
		if (!client?.authenticated || !client.usable) {
			throw new Error(
				`[mail:move] IMAP indisponible pour l'identite ${srcMailbox.identityId} : rien deplace, ni en base ni sur le serveur`,
			);
		}
	}

	// ss2i : la base d'abord, IMAP ensuite. L'amont faisait l'inverse : le fil restait a sa
	// place dans l'interface pendant tout l'aller-retour IMAP (plusieurs secondes chez Gmail),
	// et l'EXPUNGE recu par la connexion temps reel pouvait supprimer la ligne avant qu'elle
	// soit deplacee. OI 10286 : ce que le serveur n'a pas deplace est remis dans le dossier
	// source en base (moveGroupOnImap), au lieu de laisser la base mentir.
	await db.transaction(async (tx) => {
		const set: Record<string, any> = {
			mailboxId: destMailboxRow.id,
			updatedAt: new Date(),
		};
		if (moveImap) {
			set.metaData = sql`
        jsonb_set(
          coalesce(${messages.metaData}, '{}'::jsonb),
          '{imap,mailboxPath}',
          to_jsonb(${destPath}::text),
          true
        )
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
			// Les recapitulatifs de fil sont par dossier : ceux de la destination sont recalcules,
			// ceux de la source aussi (fil partiel) ou supprimes (fil parti en entier).
			for (const threadId of [...plan.fullThreadIds, ...plan.partialThreadIds]) {
				const movedOne = toMove.find((m) => m.threadId === threadId)!;
				await upsertMailboxThreadItem(movedOne.id, tx as any);
				const stay = threadMsgs.find((m) => m.threadId === threadId && !movingIds!.has(m.id));
				if (stay) {
					await upsertMailboxThreadItem(stay.id, tx as any);
				} else {
					await tx
						.delete(mailboxThreads)
						.where(
							and(
								eq(mailboxThreads.threadId, threadId),
								eq(mailboxThreads.mailboxId, fromMailboxId),
							),
						);
				}
			}
			return;
		}

		// ss2i (OI 10286) : un fil qui a deja sa ligne dans le dossier d'arrivee (cle
		// thread_id + mailbox_id) faisait echouer TOUT le job : corbeilles de 2 434 et 2 137 fils
		// du 04/11 perdues pour 9 fils deja en Deleted Items. Ces fils-la sont fusionnes dans la
		// ligne existante, les autres changent de dossier comme avant.
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
			const one = toMove.find((m) => m.threadId === t);
			if (one) await upsertMailboxThreadItem(one.id, tx as any);
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
		movingIds: toMove.map((m) => m.id),
		threadOf: new Map(toMove.map((m) => [m.id, m.threadId])),
	};
	let reverted = 0;
	for (const g of byPath.values()) reverted += await moveGroupOnImap(client, g, ctx);
	if (reverted) {
		// Le job echoue (donc rejoue par BullMQ) : les messages remis dans la source repartiront.
		throw new Error(
			`[mail:move] ${reverted} message(s) non deplaces sur IMAP (${srcMailbox.name} -> ${destPath}), remis dans ${srcMailbox.name} en base`,
		);
	}
};

type MoveCtx = {
	src: typeof mailboxes.$inferSelect;
	dest: typeof mailboxes.$inferSelect;
	destPath: string;
	// Tous les messages du job : leur UID en base est encore celui de la source.
	movingIds: string[];
	threadOf: Map<string, string>;
};

/**
 * ss2i (OI 10286) : MOVE IMAP d'un dossier source, sous UN verrou de la connexion (aucune
 * synchronisation ne s'intercale) :
 * 1. resolveUids (UID reels dans la source, verifies par Message-ID) ;
 * 2. UIDNEXT du dossier d'arrivee (STATUS) et curseur deltaFetch avance sur le lot ;
 * 3. UID MOVE ; imapflow rend false sur un refus, sans lever ni journaliser : on le dit ;
 * 4. relecture du dossier d'arrivee (EXAMINE, UID >= UIDNEXT d'avant) et UID recopies par
 *    Message-ID (matchMovedUids), jamais par la position dans le COPYUID que Stalwart permute ;
 * 5. ce qui n'est pas arrive est cherche dans la source a son UID : s'il y est, il est remis
 *    dans le dossier source en base (le serveur ne l'a pas deplace) ; s'il n'est nulle part,
 *    il reste a destination sans UID.
 * Rend le nombre de messages remis dans la source.
 */
async function moveGroupOnImap(
	client: ImapFlow,
	g: { path: string; rows: UidRow[] },
	ctx: MoveCtx,
): Promise<number> {
	const { path: srcPath, rows } = g;
	const tag = `${ctx.src.identityId} ${srcPath} -> ${ctx.destPath}`;
	const rowById = new Map(rows.map((r) => [r.id, r]));
	const settled = new Set<string>();
	const srcUid = new Map<string, number>();
	let state: "avant" | "envoye" | "fait" | "refuse" = "avant";
	let cursor: Cursor | null = null;
	let reverted = 0;

	let lock: { release: () => void };
	try {
		lock = await client.getMailboxLock(srcPath);
	} catch (err) {
		console.error(`[mail:move] dossier source illisible (${tag}) : ${rows.length} message(s) remis dans la source en base`, err);
		return await revertToSource(rows.map((r) => ({ id: r.id, uid: r.uid })), srcPath, ctx);
	}
	try {
		const wanted = await resolveUids(client, rows);
		for (const [uid, id] of wanted) if (!srcUid.has(id)) srcUid.set(id, uid);
		const toCheck = rows.filter((r) => !srcUid.has(r.id)).map((r) => r.id);

		if (wanted.size) {
			const st = await client.status(ctx.destPath, { uidNext: true });
			const u0 = Number((st && st.uidNext) || 0);
			if (!u0) throw new Error(`UIDNEXT de ${ctx.destPath} illisible (STATUS)`);
			cursor = await preAdvanceDestCursor(ctx.dest.id, u0, wanted.size);

			state = "envoye";
			const moved = await client.messageMove([...wanted.keys()], ctx.destPath, { uid: true });
			state = moved ? "fait" : "refuse";
			if (!moved) {
				console.error(`[mail:move] UID MOVE refuse par le serveur (${tag}), ${wanted.size} UID`);
			}

			const box = await client.mailboxOpen(ctx.destPath, { readOnly: true });
			// Gmail : un message deja present a l'arrivee (« Tous les messages ») garde son UID,
			// inferieur a UIDNEXT ; celui du COPYUID est relu aussi, puis verifie par Message-ID.
			const copyUids = moved && moved.uidMap ? [...moved.uidMap.values()] : [];
			const found = await readArrived(client, Number(box?.exists ?? 0), u0, copyUids);

			const movedRows = [...new Set(wanted.values())].map((id) => rowById.get(id)!);
			const taken = heldUids(found, await heldInDest(ctx, found));
			const m = matchMovedUids(movedRows, found, taken);
			for (const [id, uid] of m.assigned) {
				await setUid(id, ctx.dest.id, uid);
				settled.add(id);
			}
			if (m.ambiguous.length) {
				await clearUid(m.ambiguous, ctx.dest.id);
				m.ambiguous.forEach((id) => settled.add(id));
				console.warn(
					`[mail:move] ${m.ambiguous.length} message(s) au Message-ID en double dans le lot (${tag}) : laisses sans UID`,
					m.ambiguous.slice(0, 20),
				);
			}
			toCheck.push(...m.missing);

			if (cursor) {
				const known = new Set([...taken, ...m.assigned.values()]);
				const target = destCursorAfterMove(
					u0,
					found.map((f) => ({ uid: f.uid, known: known.has(f.uid) })),
				);
				await settleDestCursor(cursor, target);
				cursor = null;
			}
		}

		if (toCheck.length) {
			// Pas arrive (ou pas trouve dans la source par resolveUids, peut-etre sur une lecture
			// en erreur) : le serveur l'a-t-il encore dans la source, a son UID ?
			await client.mailboxOpen(srcPath, { readOnly: true });
			const uidOf = (id: string) => srcUid.get(id) ?? rowById.get(id)!.uid;
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
					`[mail:move] ${back.length} message(s) toujours dans ${srcPath} sur le serveur (${tag}) : remis dans le dossier source en base`,
					back.slice(0, 20).map((b) => b.id),
				);
			}
			if (nowhere.length) {
				await clearUid(nowhere, ctx.dest.id);
				nowhere.forEach((id) => settled.add(id));
				console.warn(
					`[mail:move] ${nowhere.length} message(s) ni dans la source ni dans le lot arrive (${tag}) : laisses a destination sans UID`,
					nowhere.slice(0, 20),
				);
			}
		}
	} catch (err) {
		const rest = rows.filter((r) => !settled.has(r.id));
		// Serveur qui a repondu OK au MOVE : ces messages sont a destination, UID inconnu.
		// Sinon (refus, coupure avant ou pendant le MOVE) : remis dans la source en base.
		const arrived = state === "fait" ? rest.filter((r) => srcUid.has(r.id)) : [];
		const back = rest.filter((r) => !arrived.includes(r));
		console.error(
			`[mail:move] IMAP en erreur (${tag}, etape ${state}) : ${back.length} message(s) remis dans la source en base, ${arrived.length} laisses a destination sans UID`,
			err,
		);
		if (cursor) await settleDestCursor(cursor, cursor.l0).catch(() => {});
		if (arrived.length) await clearUid(arrived.map((r) => r.id), ctx.dest.id);
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

// Enveloppes du dossier ouvert : UID >= u0 (arrives depuis le MOVE) et UID du COPYUID
// inferieurs a u0.
async function readArrived(
	client: ImapFlow,
	exists: number,
	u0: number,
	copyUids: number[],
): Promise<DestEnvelope[]> {
	const out = new Map<number, string | null>();
	if (exists > 0) {
		// « u0:* » rend aussi le dernier message quand rien n'est au-dessus : on filtre.
		for await (const m of client.fetch(`${u0}:*`, { uid: true, envelope: true }, { uid: true })) {
			if (Number(m.uid) >= u0) out.set(Number(m.uid), m.envelope?.messageId ?? null);
		}
		const extra = [...new Set(copyUids.map(Number))].filter((u) => u > 0 && u < u0);
		if (extra.length) {
			for await (const m of client.fetch(extra.join(","), { uid: true, envelope: true }, { uid: true })) {
				out.set(Number(m.uid), m.envelope?.messageId ?? null);
			}
		}
	}
	return [...out].map(([uid, messageId]) => ({ uid, messageId }));
}

// UID -> Message-ID normalise, pour des UID du dossier ouvert (absents : pas dans la Map).
async function envelopesAt(client: ImapFlow, uids: number[]) {
	const out = new Map<number, string>();
	const list = [...new Set(uids.map(Number))].filter((u) => u > 0);
	for (let i = 0; i < list.length; i += 500) {
		const part = list.slice(i, i + 500);
		for await (const m of client.fetch(part.join(","), { uid: true, envelope: true }, { uid: true })) {
			out.set(Number(m.uid), normMessageId(m.envelope?.messageId));
		}
	}
	return out;
}

// Messages du dossier d'arrivee (hors job) qui tiennent deja l'un de ces UID en base.
async function heldInDest(ctx: MoveCtx, found: DestEnvelope[]): Promise<DestEnvelope[]> {
	if (!found.length) return [];
	const uidText = sql<string>`${messages.metaData}->'imap'->>'uid'`;
	const rows = await db
		.select({ uid: uidText, messageId: messages.messageId })
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, ctx.dest.id),
				inArray(uidText, found.map((f) => String(f.uid))),
				ctx.movingIds.length ? notInArray(messages.id, ctx.movingIds) : undefined,
			),
		);
	return rows.map((r) => ({ uid: Number(r.uid), messageId: r.messageId }));
}

const setUid = (id: string, mailboxId: string, uid: number) =>
	db
		.update(messages)
		.set({
			metaData: sql`
        jsonb_set(
          coalesce(${messages.metaData}, '{}'::jsonb),
          '{imap,uid}',
          to_jsonb(${Number(uid)}::bigint),
          true
        )
      `,
		})
		.where(and(eq(messages.id, id), eq(messages.mailboxId, mailboxId)));

// Pas d'UID plutot qu'un UID faux : un lu / non lu / etoile ne verifie pas le Message-ID.
const clearUid = (ids: string[], mailboxId: string) =>
	db
		.update(messages)
		.set({ metaData: sql`${messages.metaData} #- '{imap,uid}'` })
		.where(and(inArray(messages.id, ids), eq(messages.mailboxId, mailboxId)));

// Remet dans le dossier source, en base, des messages que le serveur n'a pas deplaces
// (chemin et UID de la source), puis recalcule les lignes de fil des deux dossiers.
async function revertToSource(
	items: Array<{ id: string; uid: number }>,
	srcPath: string,
	ctx: MoveCtx,
): Promise<number> {
	if (!items.length) return 0;
	let n = 0;
	await db.transaction(async (tx) => {
		for (const it of items) {
			const r = await tx
				.update(messages)
				.set({
					mailboxId: ctx.src.id,
					updatedAt: new Date(),
					metaData: sql`
            jsonb_set(
              jsonb_set(coalesce(${messages.metaData}, '{}'::jsonb), '{imap,mailboxPath}', to_jsonb(${srcPath}::text), true),
              '{imap,uid}',
              to_jsonb(${Number(it.uid)}::bigint),
              true
            )
          `,
				})
				.where(and(eq(messages.id, it.id), eq(messages.mailboxId, ctx.dest.id)))
				.returning({ id: messages.id });
			n += r.length;
		}
		const threadIds = [...new Set(items.map((it) => ctx.threadOf.get(it.id)))].filter(Boolean) as string[];
		for (const t of threadIds) await resettleThread(tx, t, ctx.dest, ctx.src);
	});
	return n;
}

// Lignes mailbox_threads d'un fil dont des messages viennent de repasser de `from` a `to`.
// Fil revenu en entier : sa ligne revient avec lui (report de rappel garde) ; sinon les deux
// lignes sont recalculees, celle d'un dossier qui n'a plus de message du fil supprimee.
async function resettleThread(
	tx: any,
	threadId: string,
	from: typeof mailboxes.$inferSelect,
	to: typeof mailboxes.$inferSelect,
) {
	const oneIn = async (mailboxId: string) =>
		(
			await tx
				.select({ id: messages.id })
				.from(messages)
				.where(and(eq(messages.threadId, threadId), eq(messages.mailboxId, mailboxId)))
				.limit(1)
		)[0]?.id as string | undefined;
	const inTo = await oneIn(to.id);
	if (!inTo) return;
	const leftFrom = await oneIn(from.id);
	const [toRow] = await tx
		.select({ threadId: mailboxThreads.threadId })
		.from(mailboxThreads)
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, to.id)))
		.limit(1);
	if (!leftFrom && !toRow) {
		await tx
			.update(mailboxThreads)
			.set({ mailboxId: to.id, mailboxSlug: to.slug ?? null, updatedAt: new Date() })
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, from.id)));
	}
	await upsertMailboxThreadItem(inTo, tx);
	if (leftFrom) {
		await upsertMailboxThreadItem(leftFrom, tx);
	} else {
		await tx
			.delete(mailboxThreads)
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, from.id)));
	}
}

// Curseur deltaFetch du dossier d'arrivee (cf. destCursorBeforeMove / destCursorAfterMove).
// Ecritures en compare-and-set, toujours sous le verrou de la connexion IMAP que deltaFetch
// partage (imapInstances) : il ne lit ni n'ecrit ce curseur pendant le deplacement.
type Cursor = { id: string; l0: number; pre: number };

async function casCursor(id: string, from: number, to: number) {
	if (from === to) return true;
	const r = await db
		.update(mailboxSync)
		.set({ lastSeenUid: to, updatedAt: new Date() })
		.where(and(eq(mailboxSync.id, id), eq(mailboxSync.lastSeenUid, from)))
		.returning({ id: mailboxSync.id });
	return r.length === 1;
}

async function preAdvanceDestCursor(mailboxId: string, u0: number, n: number): Promise<Cursor | null> {
	const [s] = await db
		.select({ id: mailboxSync.id, lastSeenUid: mailboxSync.lastSeenUid })
		.from(mailboxSync)
		.where(eq(mailboxSync.mailboxId, mailboxId))
		.limit(1);
	if (!s) return null;
	const l0 = Number(s.lastSeenUid ?? 0);
	const pre = destCursorBeforeMove(l0, u0, n);
	if (pre === null || !(await casCursor(s.id, l0, pre))) return null;
	return { id: s.id, l0, pre };
}

async function settleDestCursor(c: Cursor, target: number) {
	if (!(await casCursor(c.id, c.pre, target))) {
		console.warn(`[mail:move] curseur ${c.id} modifie pendant le deplacement (attendu ${c.pre}), laisse tel quel`);
	}
}
