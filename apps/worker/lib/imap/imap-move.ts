import { db, mailboxes, messages, mailboxThreads } from "@db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { initSmtpClient } from "./imap-client";
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
		moveImap,
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
		})
		.from(messages)
		.where(
			and(
				inArray(messages.threadId, ids),
				eq(messages.mailboxId, fromMailboxId),
			),
		);
	if (threadMsgs.length === 0) return;

	// A relever AVANT la mise a jour en base, qui reecrit imap.mailboxPath.
	type Group = { path: string; rows: UidRow[] };
	const byPath = new Map<string, Group>();
	if (moveImap) {
		for (const m of threadMsgs) {
			const im = (m.meta as any)?.imap;
			const uid = im?.uid as number | undefined;
			const srcPath = im?.mailboxPath as string | undefined;
			if (!uid || !srcPath) continue;
			const g = byPath.get(srcPath) ?? { path: srcPath, rows: [] };
			g.rows.push({ id: m.id, uid: Number(uid), messageId: m.messageId });
			byPath.set(srcPath, g);
		}
	}

	// ss2i : la base d'abord, IMAP ensuite. L'amont faisait l'inverse : le fil restait a sa
	// place dans l'interface pendant tout l'aller-retour IMAP (plusieurs secondes chez Gmail),
	// et l'EXPUNGE recu par la connexion temps reel pouvait supprimer la ligne avant qu'elle
	// soit deplacee. L'issue est la meme qu'avant en cas d'echec IMAP : la base est a jour.
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
				and(
					inArray(messages.threadId, ids),
					eq(messages.mailboxId, fromMailboxId),
				),
			);

		await tx
			.update(mailboxThreads)
			.set({
				mailboxId: destMailboxRow.id,
				mailboxSlug: op === "move" ? (destMailboxRow.slug ?? "custom") : op,
				updatedAt: new Date(),
			})
			.where(
				and(
					inArray(mailboxThreads.threadId, ids),
					eq(mailboxThreads.mailboxId, fromMailboxId),
				),
			);
	});

	if (!moveImap) return;
	if (!byPath.size) {
		console.debug(
			"[mail:move] No IMAP-backed UIDs to move; DB-only move was applied.",
		);
		return;
	}

	const client = await initSmtpClient(srcMailbox.identityId, imapInstances);
	if (!client?.authenticated || !client.usable) {
		console.error("[mail:move] IMAP client unavailable, DB-only move applied");
		return;
	}

	try {
		for (const { path: srcPath, rows } of byPath.values()) {
			let wanted = new Map<number, string>();
			let moved: { uidMap?: Map<number, number> } | false | undefined;
			const lock = await client.getMailboxLock(srcPath);
			try {
				wanted = await resolveUids(client, rows);
				if (wanted.size) {
					moved = await client.messageMove([...wanted.keys()], destPath, {
						uid: true,
					});
				}
			} finally {
				lock.release();
			}

			// ss2i : le message a un nouvel UID dans le dossier d'arrivee (reponse COPYUID).
			// L'amont gardait l'ancien, qui designe un autre message de ce dossier.
			const uidMap = moved ? moved.uidMap : undefined;
			if (!uidMap) continue;
			for (const [srcUid, destUid] of uidMap) {
				const id = wanted.get(Number(srcUid));
				if (!id || !destUid) continue;
				await db
					.update(messages)
					.set({
						metaData: sql`
              jsonb_set(
                coalesce(${messages.metaData}, '{}'::jsonb),
                '{imap,uid}',
                to_jsonb(${Number(destUid)}::int),
                true
              )
            `,
					})
					.where(eq(messages.id, id));
			}
		}
	} catch (err) {
		console.error("[mail:move] IMAP move failed:", err);
	}
};
