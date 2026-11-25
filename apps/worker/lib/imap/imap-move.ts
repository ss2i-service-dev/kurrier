import { db, mailboxes, mailboxSync, messages, mailboxThreads } from "@db";
import { eligibleCleanupThreads, loadCleanupRule, upsertMailboxThreadItem, type CleanupRuleCtx } from "@common";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
	parseExpiry,
	type DestEnvelope,
} from "@common";
import { resolveUids, type UidRow } from "./imap-resolve-uids";
import { dueExpiredThreads } from "../mail-expiry";

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
	// ss2i (archive-duree-de-vie) : echeance ISO d'un archivage avec duree de vie (op archive,
	// ecrite sur la ligne d'arrivee seulement si le dossier d'arrivee est l'archive et la date
	// valide, cf. parseExpiry) ; `expiry` marque le job de Corbeille poste par mail:expire-tick.
	expiresAt?: string | null;
	expiry?: boolean;
	// ss2i (nettoyage-auto-recherche) : id de la regle de nettoyage qui a poste le job (op trash,
	// mail:cleanup-tick) ; regle et fils reverifies au debut puis sous verrou par moveMail.
	cleanupRuleId?: string;
};

// Job du tick : l'echeance a change entre la verification du debut et la transaction.
class ExpiryChanged extends Error {}

export const moveMail = async (
	data: MoveJob,
	imapInstances: Map<string, ImapFlow>,
	expiryRetry = 0,
): Promise<void> => {
	const {
		threadId,
		threadIds: batchIds,
		mailboxId: fromMailboxId,
		op,
		toMailboxId,
	} = data;

	let ids = (batchIds?.length ? batchIds : [threadId]).map(String).filter(Boolean);
	if (!ids.length) return;

	// Source mailbox
	const [srcMailbox] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, fromMailboxId));
	if (!srcMailbox) return;

	// ss2i (archive-duree-de-vie) : job du tick, seuls les fils encore dus partent (etoile, retour
	// dans l'Inbox, echeance videe ou repoussee depuis le tick : rien), en entier (messageIds
	// ignore). Revérifie sous verrou dans la transaction.
	const now = new Date();
	if (data.expiry) {
		if (srcMailbox.kind !== "archive" || op !== "trash") return;
		ids = (await dueExpiredThreads(db, { now, mailboxId: fromMailboxId, threadIds: ids })).map((t) => t.threadId);
		if (!ids.length) return;
	}

	// ss2i (nettoyage-auto-recherche) : job de mail:cleanup-tick. Regle relue (null si supprimee ou si
	// son identite n'est plus a son auteur) ; en pause, autre op que trash ou dossier source hors de sa
	// portee : rien. Seuls les fils encore eligibles partent (etoile, message recent, report depuis le
	// tick : rien), en entier (messageIds ignore). Reverifie sous verrou dans la transaction. `!= null` :
	// un id vide ou invalide ne devient jamais une Corbeille ordinaire.
	let rule: CleanupRuleCtx | null = null;
	if (data.cleanupRuleId != null) {
		rule = op === "trash" ? await loadCleanupRule(db, String(data.cleanupRuleId)) : null;
		if (!rule || rule.paused || !rule.mailboxIds.includes(fromMailboxId)) return;
		ids = (await eligibleCleanupThreads(db, rule, { now, threadIds: ids, mailboxId: fromMailboxId })).map((t) => t.threadId);
		if (!ids.length) return;
	}

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

	// ss2i (16/11/2026) : on ne range pas du courrier dans les Brouillons ; seul le service de
	// brouillons y ecrit.
	if (destMailboxRow?.kind === "drafts") {
		console.warn(`[mail:move] destination Brouillons refusee (identity=${srcMailbox.identityId})`);
		return;
	}

	if (!destMailboxRow) {
		console.warn(
			`[mail:move] No destination for op=${op} identity=${srcMailbox.identityId}`,
		);
		return;
	}

	// ss2i : « corbeille -> corbeille » (Delete clique depuis la corbeille) n'a rien a deplacer.
	if (destMailboxRow.id === fromMailboxId) return;

	// ss2i (archive-duree-de-vie) : echeance de la ligne d'arrivee, ecrite dans la transaction du
	// deplacement ; tout autre deplacement (ou une date invalide, passee) ecrit NULL.
	const exp = destMailboxRow.kind === "archive" ? parseExpiry(data.expiresAt, new Date()) : null;

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
	const plan = data.messageIds?.length && !data.expiry && !rule
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
	const folderPath: string = (srcMailbox.metaData as any)?.imap?.path ?? srcMailbox.name;
	if (moveImap) {
		for (const m of toMove) {
			const im = (m.meta as any)?.imap;
			const uid = Number(im?.uid ?? 0);
			// ss2i (18/11) : une ligne sans UID (laissee sans UID par un deplacement precedent) est
			// cherchee par Message-ID dans le dossier source (resolveUids, UID 0) au lieu d'un
			// deplacement en base seule : la base disait Corbeille, Gmail gardait le message dans
			// l'INBOX. Sans Message-ID, rien a chercher : base seule, comme avant.
			const srcPath = uid > 0 ? (im?.mailboxPath as string | undefined) : normMessageId(m.messageId) ? folderPath : undefined;
			if (!srcPath) continue;
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
	const dupIds = new Set<string>();
	const srcExpiry = new Map<string, Date>();
	const expiryChanged = await db.transaction(async (tx) => {
		// ss2i (OI 10286) : copie deja presente a l'arrivee (meme Message-ID : envoi a soi-meme,
		// copie des Envoyes deja rangee la) : l'index unique (mailbox_id, message_id) faisait
		// echouer tout le job. La ligne source est supprimee en base, la copie d'arrivee la
		// represente ; son UID reste dans le MOVE IMAP (byPath) et l'UID d'arrivee compte comme
		// connu pour le curseur.
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
				`[mail:move] ${dupIds.size} message(s) deja presents dans ${destPath} (meme Message-ID) : ligne source supprimee en base, copie IMAP deplacee`,
			);
		}

		const set: Record<string, any> = {
			mailboxId: destMailboxRow.id,
			updatedAt: new Date(),
		};
		if (moveImap) {
			// ss2i (OI 10286) : l'UID de la source part avec le changement de dossier (il est releve
			// avant, dans byPath) ; un arret du worker entre cette transaction et la recopie des UID
			// laissait sinon un UID de la source sur un chemin d'arrivee. ss2i (18/11) : objet imap
			// cree au besoin (ligne sans UID partie par Message-ID), jsonb_set ne cree pas les
			// niveaux intermediaires et laissait la ligne sans chemin ni UID.
			set.metaData = sql`
        jsonb_set(
          (case when jsonb_typeof(${messages.metaData}) = 'object' then ${messages.metaData} else '{}'::jsonb end) || jsonb_build_object('imap', coalesce(${messages.metaData}->'imap', '{}'::jsonb)),
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

		// ss2i (archive-duree-de-vie) : job du tick, echeance revérifiee sous verrou, apres les
		// messages (meme ordre de verrous que l'etoile cote web : messages, puis fils). Etoile,
		// message arrive dans l'Inbox ou echeance changee depuis le debut du job : tout est annule
		// et le job recommence, son debut ne garde que ce qui est encore du. L'echeance relue sert
		// a la remettre sur la ligne Archive si le serveur refuse le MOVE (resettleThread).
		if (data.expiry) {
			const still = await dueExpiredThreads(tx, { now, mailboxId: fromMailboxId, threadIds: ids, forUpdate: true });
			if (still.length !== ids.length) throw new ExpiryChanged();
			for (const t of still) srcExpiry.set(t.threadId, t.expiresAt);
		}

		// ss2i (nettoyage-auto-recherche) : job de nettoyage, meme principe. La regle est verrouillee
		// (for share : une pause ou une suppression attend la fin du move) puis relue sous ce verrou
		// (duree, filtres, proprietaire de l'identite) ; regle partie ou en pause, fil etoile, reactive
		// ou reporte depuis le debut du job : tout est annule et le job recommence. L'echeance d'une
		// ligne Archive est gardee pour la remettre si le serveur refuse le MOVE (resettleThread).
		if (rule) {
			const [locked] = (await tx.execute(
				sql`select 1 from cleanup_rules where id = ${rule.ruleId}::uuid and not paused for share`,
			)) as any[];
			const live = locked ? await loadCleanupRule(tx, rule.ruleId) : null;
			if (!live || live.paused || !live.mailboxIds.includes(fromMailboxId)) throw new ExpiryChanged();
			const still = await eligibleCleanupThreads(tx, live, { now, threadIds: ids, mailboxId: fromMailboxId, forUpdate: true });
			if (still.length !== ids.length) throw new ExpiryChanged();
			if (srcMailbox.kind === "archive") for (const t of still) if (t.expiresAt) srcExpiry.set(t.threadId, t.expiresAt);
		}

		if (plan) {
			// Les recapitulatifs de fil sont par dossier : ceux de la destination sont recalcules,
			// ceux de la source aussi (fil partiel) ou supprimes (fil parti en entier).
			const touched = [...plan.fullThreadIds, ...plan.partialThreadIds];
			for (const threadId of touched) {
				await refreshThreadIn(tx, threadId, destMailboxRow.id);
				await refreshThreadIn(tx, threadId, fromMailboxId);
			}
			await setArrivalExpiry(tx, touched, destMailboxRow.id, exp);
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
					expiresAt: exp,
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
		// Fils fusionnes, et fils dont une copie a ete supprimee (compteurs a refaire).
		const dupThreads = toMove.filter((m) => dupIds.has(m.id)).map((m) => m.threadId);
		for (const t of new Set([...clash, ...dupThreads])) {
			await refreshThreadIn(tx, t, destMailboxRow.id);
		}
		await setArrivalExpiry(tx, [...clash], destMailboxRow.id, exp);
	}).then(
		() => false,
		(err) => {
			if (err instanceof ExpiryChanged) return true;
			throw err;
		},
	);
	if (expiryChanged) {
		if (expiryRetry >= 3) throw new Error(`[mail:move] ${rule ? "regle ou fils de nettoyage changes" : "echeances changees"} pendant le job (${fromMailboxId}) : rien deplace, rejoue plus tard`);
		return moveMail(data, imapInstances, expiryRetry + 1);
	}

	// ss2i (nettoyage-auto-recherche) : compteur de la regle, a chaque sortie, MOVE IMAP fait, refuse
	// ou en erreur (finally) : ce qui est parti compte, ce qui est remis dans la source comptera au
	// job rejoue.
	try {
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
			srcExpiry,
			expiry: !!data.expiry,
			cleanup: !!rule,
		};
		let reverted = 0;
		for (const g of byPath.values()) reverted += await moveGroupOnImap(client, g, ctx);
		if (reverted) {
			// Le job echoue (donc rejoue par BullMQ) : les messages remis dans la source repartiront.
			throw new Error(
				`[mail:move] ${reverted} message(s) non deplaces sur IMAP (${srcMailbox.name} -> ${destPath}), remis dans ${srcMailbox.name} en base`,
			);
		}
	} finally {
		if (rule) await countCleanup(rule.ruleId, ids, fromMailboxId);
	}
};

// ss2i (nettoyage-auto-recherche) : fils du job qui n'ont plus aucun message dans le dossier source
// (partis en entier : ni etoiles \Flagged ni refuses par le serveur, tous deux remis dans la source)
// ajoutes au compteur de la regle ; rien d'ecrit s'il n'y en a aucun. Une erreur ici ne fait pas
// echouer le job : le deplacement est fait, seul le compteur serait faux.
async function countCleanup(ruleId: string, threadIds: string[], fromMailboxId: string) {
	try {
		await db.execute(sql`
			update cleanup_rules c
			set trashed_count = c.trashed_count + g.n, last_trashed_at = now()
			from (
				select count(*)::int as n
				from unnest(${`{${threadIds.join(",")}}`}::uuid[]) as t(id)
				where not exists (select 1 from messages m where m.thread_id = t.id and m.mailbox_id = ${fromMailboxId}::uuid)
			) g
			where c.id = ${ruleId}::uuid and g.n > 0
		`);
	} catch (err) {
		console.error(`[mail:move] compteur de la regle de nettoyage ${ruleId} non mis a jour`, err);
	}
}

// Tranches : Postgres refuse plus de 65 534 parametres par requete, et un seul job peut porter
// plusieurs dizaines de milliers de messages (archivage du 04/11 : 54 119).
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
	// Messages dont une copie (meme Message-ID) etait deja a l'arrivee : ligne source supprimee
	// dans la transaction, rien a remettre dans la source.
	dupIds: Set<string>;
	threadOf: Map<string, string>;
	// ss2i (archive-duree-de-vie) : job du tick, echeance de chaque fil dans l'Archive source.
	srcExpiry: Map<string, Date>;
	expiry: boolean;
	// ss2i (nettoyage-auto-recherche) : job d'une regle de nettoyage (garde \Flagged comme expiry).
	cleanup: boolean;
};

/**
 * ss2i (OI 10286) : MOVE IMAP d'un dossier source, sous UN verrou de la connexion (aucune
 * synchronisation ne s'intercale) :
 * 1. resolveUids (UID reels dans la source, verifies par Message-ID) ; ce qu'il ne trouve pas
 *    n'est pas envoye et est remis dans la source en base ;
 * 2. UIDNEXT du dossier d'arrivee (STATUS) et curseur deltaFetch lu ;
 * 3. UID MOVE ; imapflow rend false sur un refus, sans lever ni journaliser : on le dit ;
 * 4. relecture du dossier d'arrivee (EXAMINE, UID >= UIDNEXT d'avant) et UID recopies par
 *    Message-ID (matchMovedUids), jamais par la position dans le COPYUID que Stalwart permute ;
 *    curseur pose en un compare-and-set ;
 * 5. ce qui a ete envoye mais n'est pas arrive est cherche dans la source a son UID : s'il y
 *    est, il est remis dans le dossier source en base (le serveur ne l'a pas deplace) ; s'il
 *    n'est nulle part, il reste a destination ;
 * 6. ce qui reste a destination sans etre arrive par le MOVE (absent de la source, ou etape 5)
 *    y est cherche par Message-ID (adoptInDest) : UID repris s'il y est, sinon sans UID.
 * Rend le nombre de messages remis dans la source.
 */
async function moveGroupOnImap(
	client: ImapFlow,
	g: { path: string; rows: UidRow[] },
	ctx: MoveCtx,
): Promise<number> {
	const srcPath = g.path;
	let rows = g.rows;
	const tag = `${ctx.src.identityId} ${srcPath} -> ${ctx.destPath}`;
	const rowById = new Map(rows.map((r) => [r.id, r]));
	const isDup = (id: string) => ctx.dupIds.has(id);
	const settled = new Set<string>();
	const srcUid = new Map<string, number>();
	const claimed = new Set<number>(); // UID d'arrivee deja attribues ou tenus (etape 6)
	const orphans: UidRow[] = []; // a destination sans etre arrives par le MOVE (etape 6)
	let adoptDone = false;
	let state: "avant" | "envoye" | "fait" | "refuse" = "avant";
	let reverted = 0;

	let lock: { release: () => void };
	try {
		lock = await client.getMailboxLock(srcPath);
	} catch (err) {
		console.error(`[mail:move] dossier source illisible (${tag}) : ${rows.length} message(s) remis dans la source en base`, err);
		return await revertToSource(
			rows.filter((r) => !isDup(r.id)).map((r) => ({ id: r.id, uid: r.uid })),
			srcPath,
			ctx,
		);
	}
	try {
		const absent = new Set<string>();
		const wanted = await resolveUids(client, rows, absent);
		for (const [uid, id] of wanted) if (!srcUid.has(id)) srcUid.set(id, uid);

		// ss2i (archive-duree-de-vie) : job du tick, etoile posee hors de courrier (telephone, Gmail
		// web) sur un fil deja archive. IDLE ne suit que l'INBOX et la synchronisation ne relit que
		// les nouveaux UID : la base l'ignore. Drapeaux lus ici, sous le verrou, avant le MOVE : un
		// fil dont un message porte \Flagged ne part pas, aucun de ses messages (trouves ou non) ; il
		// est remis dans la source en base, etoile, sans echeance, et ne compte pas comme un echec
		// du job. Lot vide ensuite : aucun MOVE. Lecture en erreur : catch, tout est remis. Meme garde
		// pour le job d'une regle de nettoyage (ctx.cleanup), en Inbox comme ailleurs.
		if ((ctx.expiry || ctx.cleanup) && wanted.size) {
			const starIds = [...(await flaggedAt(client, [...wanted.keys()]))].map((u) => wanted.get(u)!);
			const keep = new Set(starIds.map((id) => ctx.threadOf.get(id)));
			if (keep.size) {
				const kept = rows.filter((r) => keep.has(ctx.threadOf.get(r.id)));
				await revertToSource(
					kept.filter((r) => !isDup(r.id)).map((r) => ({ id: r.id, uid: srcUid.get(r.id) ?? (absent.has(r.id) ? 0 : r.uid) })),
					srcPath,
					ctx,
					starIds,
				);
				for (const [uid, id] of wanted) if (keep.has(ctx.threadOf.get(id))) wanted.delete(uid);
				rows = rows.filter((r) => !keep.has(ctx.threadOf.get(r.id)));
				console.warn(
					`[mail:move] ${keep.size} fil(s) etoile(s) sur le serveur (\\Flagged) dans ${srcPath} (${tag}) : ${ctx.expiry ? "echeance annulee" : "nettoyage annule"}, laisses dans la source, etoiles en base`,
					[...keep].slice(0, 20),
				);
			}
		}

		// ss2i (12/11, Spam Gmail de sam.legros@) : absence de la source PROUVEE (dossier lu en
		// entier) : le message n'est plus sur le serveur (supprime depuis un autre client, Gmail
		// qui vide son Spam), seule la base l'avait encore. Le remettre dans la source le faisait
		// revenir a chaque « vider le spam » et le job echouait sans fin : il reste a destination,
		// avec l'UID qu'il y a deja s'il y est (etape 6), sinon sans UID.
		const gone = rows.filter((r) => !srcUid.has(r.id) && absent.has(r.id));
		gone.forEach((r) => settled.add(r.id));
		orphans.push(...gone.filter((r) => !isDup(r.id)));
		// Ligne sans UID introuvable sans preuve d'absence (gros dossier Stalwart, SEARCH en echec) :
		// deplacee en base seule comme avant (etape 6), jamais remise dans la source (le job
		// echouerait a chaque reprise, rien ne permettant de la retrouver).
		const blind = rows.filter((r) => !srcUid.has(r.id) && !absent.has(r.id) && !(r.uid > 0));
		blind.forEach((r) => settled.add(r.id));
		orphans.push(...blind.filter((r) => !isDup(r.id)));

		// Jamais envoyes dans le MOVE : resolveUids ne les a pas trouves dans la source (UID
		// perime que Stalwart ne retrouve pas : SEARCH HEADER vide, balayage borne a 5 000
		// messages ; ou lecture en erreur). Le serveur ne les a peut-etre pas deplaces : remis
		// dans la source en base, sans relire leur UID en base, qui designe peut-etre un autre
		// message.
		const notSent = rows.filter((r) => !srcUid.has(r.id) && !absent.has(r.id) && r.uid > 0);
		if (notSent.length) {
			const back = notSent.filter((r) => !isDup(r.id));
			reverted += await revertToSource(back.map((r) => ({ id: r.id, uid: r.uid })), srcPath, ctx);
			notSent.forEach((r) => settled.add(r.id));
			console.error(
				`[mail:move] ${notSent.length} message(s) introuvables dans ${srcPath} par leur UID ou leur Message-ID (${tag}) : pas envoyes dans le MOVE, ${back.length} remis dans le dossier source en base`,
				notSent.slice(0, 20).map((r) => r.id),
			);
		}

		let toCheck: string[] = [];
		if (wanted.size) {
			const st = await client.status(ctx.destPath, { uidNext: true });
			const u0 = Number((st && st.uidNext) || 0);
			if (!u0) throw new Error(`UIDNEXT de ${ctx.destPath} illisible (STATUS)`);
			const cursor = await readDestCursor(ctx.dest.id);

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

			const sentIds = [...new Set(wanted.values())];
			const movedRows = sentIds.filter((id) => !isDup(id)).map((id) => rowById.get(id)!);
			const taken = heldUids(found, await heldInDest(ctx, found));
			const m = matchMovedUids(movedRows, found, taken);
			for (const u of [...taken, ...m.assigned.values()]) claimed.add(Number(u));
			await setUids([...m.assigned], ctx.dest.id);
			for (const id of m.assigned.keys()) settled.add(id);
			if (m.ambiguous.length) {
				m.ambiguous.forEach((id) => settled.add(id));
				console.warn(
					`[mail:move] ${m.ambiguous.length} message(s) au Message-ID en double a l'arrivee (${tag}) : laisses sans UID`,
					m.ambiguous.slice(0, 20),
				);
			}

			// Copies supprimees en base (dupIds) : rien a remettre ; on dit seulement si le serveur
			// ne les a pas deplacees (elles restent dans la source sans ligne en base).
			const dupSent = sentIds.filter(isDup);
			if (dupSent.length) {
				dupSent.forEach((id) => settled.add(id));
				const arrivedMids = new Set(found.filter((f) => f.uid >= u0).map((f) => normMessageId(f.messageId)));
				const lost = dupSent.filter((id) => !arrivedMids.has(normMessageId(rowById.get(id)!.messageId)));
				if (lost.length) {
					console.error(
						`[mail:move] ${lost.length} copie(s) deja presente(s) a l'arrivee non deplacee(s) par le serveur (${tag}) : restee(s) dans ${srcPath}, sans ligne en base`,
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
					console.warn(`[mail:move] curseur ${cursor.id} modifie pendant le deplacement (attendu ${cursor.l0}), laisse tel quel`);
				}
			}
			toCheck = m.missing;
		}

		if (toCheck.length) {
			// Envoye mais pas arrive : le serveur l'a-t-il encore dans la source, a l'UID que
			// resolveUids y a verifie ?
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
					`[mail:move] ${back.length} message(s) toujours dans ${srcPath} sur le serveur (${tag}) : remis dans le dossier source en base`,
					back.slice(0, 20).map((b) => b.id),
				);
			}
			if (nowhere.length) {
				nowhere.forEach((id) => settled.add(id));
				orphans.push(...nowhere.map((id) => rowById.get(id)!));
			}
		}

		if (orphans.length) {
			adoptDone = true;
			const adopted = await adoptInDest(client, orphans, ctx, claimed).catch((err) => {
				console.warn(`[mail:move] recherche par Message-ID dans ${ctx.destPath} en erreur (${tag})`, err);
				return new Set<string>();
			});
			const left = orphans.filter((r) => !adopted.has(r.id));
			const nGone = gone.filter((r) => !isDup(r.id)).length;
			const nBlind = blind.filter((r) => !isDup(r.id)).length;
			console.warn(
				`[mail:move] ${orphans.length} message(s) pas arrives par le MOVE (${nGone} absents de ${srcPath}, absence prouvee ; ${nBlind} sans UID introuvables sans preuve ; ${orphans.length - nGone - nBlind} ni dans la source ni dans le lot arrive ; ${tag}) : ${adopted.size} deja dans ${ctx.destPath}, UID repris par Message-ID ; ${left.length} laisses a destination sans UID`,
				left.slice(0, 20).map((r) => r.id),
			);
		}
	} catch (err) {
		if (orphans.length && !adoptDone) {
			console.warn(
				`[mail:move] ${orphans.length} message(s) absents de ${srcPath} laisses a destination sans UID, sans recherche par Message-ID (${tag})`,
				orphans.slice(0, 20).map((r) => r.id),
			);
		}
		const rest = rows.filter((r) => !settled.has(r.id) && !isDup(r.id));
		// Serveur qui a repondu OK au MOVE : ces messages sont a destination, UID inconnu (deja
		// retire en base). Sinon (refus, coupure avant ou pendant le MOVE) : remis dans la source.
		const arrived = state === "fait" ? rest.filter((r) => srcUid.has(r.id)) : [];
		const back = rest.filter((r) => !arrived.includes(r));
		console.error(
			`[mail:move] IMAP en erreur (${tag}, etape ${state}) : ${back.length} message(s) remis dans la source en base, ${arrived.length} laisses a destination sans UID`,
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
		for (const part of chunks(extra, 500)) {
			for await (const m of client.fetch(part.join(","), { uid: true, envelope: true }, { uid: true })) {
				out.set(Number(m.uid), m.envelope?.messageId ?? null);
			}
		}
	}
	return [...out].map(([uid, messageId]) => ({ uid, messageId }));
}

// UID -> Message-ID normalise, pour des UID du dossier ouvert (absents : pas dans la Map).
// ss2i (archive-duree-de-vie) : UID du dossier selectionne qui portent \Flagged.
async function flaggedAt(client: ImapFlow, uids: number[]) {
	const out = new Set<number>();
	const list = [...new Set(uids.map(Number))].filter((u) => u > 0);
	for (const part of chunks(list, 500)) {
		for await (const m of client.fetch(part.join(","), { uid: true, flags: true }, { uid: true })) {
			if (m.flags?.has("\\Flagged")) out.add(Number(m.uid));
		}
	}
	return out;
}

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

// Messages du dossier d'arrivee (hors job) qui tiennent deja l'un de ces UID en base. Par
// tranches (limite de parametres), les messages du job ecartes ici plutot qu'en SQL.
/**
 * ss2i (18/11, Gmail de sam.legros@ : 526 messages archives sans UID les 16 et 18/11) : messages
 * restes a destination sans etre arrives par le MOVE. Chez Gmail, un message deja archive ou mis a
 * la corbeille par un autre client est absent de l'INBOX mais present a l'arrivee (« Tous les
 * messages » a tout ce qui n'est ni Spam ni Corbeille), a son UID d'origine. Il y est cherche par
 * Message-ID (resolveUids : SEARCH HEADER, X-GM-RAW chez Gmail, lecture d'un petit dossier) ;
 * l'UID n'est repris que s'il est seul pour ce message, porte bien ce Message-ID, n'est tenu par
 * aucune autre ligne du dossier ni deja attribue par ce job. Rend les lignes qui ont un UID.
 */
async function adoptInDest(client: ImapFlow, rows: UidRow[], ctx: MoveCtx, claimed: Set<number>): Promise<Set<string>> {
	const list = rows.filter((r) => normMessageId(r.messageId));
	if (!list.length) return new Set();
	await client.mailboxOpen(ctx.destPath, { readOnly: true });
	const found = await resolveUids(client, list.map((r) => ({ id: r.id, uid: 0, messageId: r.messageId })));
	const uidsOf = new Map<string, number[]>();
	for (const [uid, id] of found) uidsOf.set(id, [...(uidsOf.get(id) ?? []), Number(uid)]);
	const single = [...uidsOf].filter(([, u]) => u.length === 1).map(([id, [uid]]) => ({ id, uid }));
	if (!single.length) return new Set();
	const perUid = new Map<number, number>();
	for (const s of single) perUid.set(s.uid, (perUid.get(s.uid) ?? 0) + 1);
	const held = new Set((await heldInDest(ctx, single.map((s) => ({ uid: s.uid, messageId: null })))).map((h) => h.uid));
	// SEARCH HEADER cherche une sous-chaine : l'enveloppe de l'UID fait foi.
	const midAt = await envelopesAt(client, single.map((s) => s.uid));
	const midOf = new Map(list.map((r) => [r.id, normMessageId(r.messageId)]));
	const pairs: Array<[string, number]> = single
		.filter((s) => perUid.get(s.uid) === 1 && !held.has(s.uid) && !claimed.has(s.uid) && midAt.get(s.uid) === midOf.get(s.id))
		.map((s) => [s.id, s.uid]);
	await setUids(pairs, ctx.dest.id);
	for (const [, uid] of pairs) claimed.add(uid);
	return new Set(pairs.map(([id]) => id));
}

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

// UID d'arrivee recopies en base : un UPDATE par tranche (et non par message), le verrou IMAP
// de la connexion etant tenu pendant ce temps.
async function setUids(pairs: Array<[string, number]>, mailboxId: string) {
	for (const part of chunks(pairs, 1000)) {
		await db.execute(sql`
			update messages
			set meta = jsonb_set((case when jsonb_typeof(messages.meta) = 'object' then messages.meta else '{}'::jsonb end), '{imap,uid}', to_jsonb(v.uid), true)
			from (values ${sql.join(
				part.map(([id, uid]) => sql`(${id}::uuid, ${Number(uid)}::bigint)`),
				sql`, `,
			)}) as v(id, uid)
			where messages.id = v.id and messages.mailbox_id = ${mailboxId}::uuid
		`);
	}
}

// Remet dans le dossier source, en base, des messages que le serveur n'a pas deplaces
// (chemin et UID de la source), puis recalcule les lignes de fil des deux dossiers.
// starIds (job du tick) : messages \Flagged sur le serveur, etoiles en base dans la meme
// transaction, puis leur fil (le trigger vide l'echeance), sans echeance reprise.
async function revertToSource(
	items: Array<{ id: string; uid: number }>,
	srcPath: string,
	ctx: MoveCtx,
	starIds: string[] = [],
): Promise<number> {
	if (!items.length) return 0;
	let n = 0;
	await db.transaction(async (tx) => {
		for (const part of chunks(items, 1000)) {
			const res = await tx.execute(sql`
				update messages
				set mailbox_id = ${ctx.src.id}::uuid,
				    updated_at = now(),
				    meta = case when v.uid > 0
				      then jsonb_set(
				        jsonb_set((case when jsonb_typeof(messages.meta) = 'object' then messages.meta else '{}'::jsonb end), '{imap,mailboxPath}', to_jsonb(${srcPath}::text), true),
				        '{imap,uid}', to_jsonb(v.uid), true)
				      -- ligne partie sans UID (cherchee par Message-ID) : aucun UID 0 ecrit
				      else jsonb_set((case when jsonb_typeof(messages.meta) = 'object' then messages.meta else '{}'::jsonb end), '{imap,mailboxPath}', to_jsonb(${srcPath}::text), true) #- '{imap,uid}'
				    end
				from (values ${sql.join(
					part.map((it) => sql`(${it.id}::uuid, ${Number(it.uid)}::bigint)`),
					sql`, `,
				)}) as v(id, uid)
				where messages.id = v.id and messages.mailbox_id = ${ctx.dest.id}::uuid
				returning messages.id
			`);
			n += (res as unknown as unknown[]).length;
		}
		// Messages avant la ligne de fil : meme ordre de verrous que l'etoile web.
		if (starIds.length) {
			await tx.update(messages).set({ flagged: true, updatedAt: new Date() }).where(inArray(messages.id, starIds));
		}
		const starred = [...new Set(starIds.map((id) => ctx.threadOf.get(id)))].filter(Boolean) as string[];
		const threadIds = [...new Set(items.map((it) => ctx.threadOf.get(it.id)))].filter(Boolean) as string[];
		for (const t of threadIds) {
			await resettleThread(tx, t, ctx.dest, ctx.src, starred.includes(t) ? null : (ctx.srcExpiry.get(t) ?? null));
		}
		if (starred.length) {
			await tx
				.update(mailboxThreads)
				.set({ starred: true, updatedAt: new Date() })
				.where(and(inArray(mailboxThreads.threadId, starred), eq(mailboxThreads.mailboxId, ctx.src.id)));
		}
	});
	return n;
}

// Ligne mailbox_threads d'un fil dans un dossier : recalculee s'il y reste un message du fil,
// supprimee sinon.
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

// Lignes mailbox_threads d'un fil dont des messages viennent de repasser de `from` a `to`.
// Fil revenu en entier : sa ligne revient avec lui (report de rappel garde) ; puis les deux
// lignes sont recalculees, celle d'un dossier qui n'a plus de message du fil supprimee.
async function resettleThread(
	tx: any,
	threadId: string,
	from: typeof mailboxes.$inferSelect,
	to: typeof mailboxes.$inferSelect,
	expiresAt: Date | null = null,
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
			.set({ mailboxId: to.id, mailboxSlug: to.slug ?? null, expiresAt: null, updatedAt: new Date() })
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, from.id)));
	}
	await refreshThreadIn(tx, threadId, to.id);
	await refreshThreadIn(tx, threadId, from.id);
	// ss2i (archive-duree-de-vie) : job du tick refuse ou partiel, la ligne revenue (ou recreee)
	// dans l'Archive reprend son echeance, sinon le job rejoue ne trouverait plus rien a faire et
	// le fil resterait en Archive sans echeance. Tout autre retour : sans echeance.
	if (expiresAt) {
		await tx
			.update(mailboxThreads)
			.set({ expiresAt })
			.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.mailboxId, to.id)));
	}
}

// ss2i (archive-duree-de-vie) : echeance des lignes d'arrivee recalculees (collision, grain du
// message) : celle du job, sinon aucune.
async function setArrivalExpiry(tx: any, threadIds: string[], mailboxId: string, exp: Date | null) {
	if (!threadIds.length) return;
	await tx
		.update(mailboxThreads)
		.set({ expiresAt: exp })
		.where(
			and(
				inArray(mailboxThreads.threadId, threadIds),
				eq(mailboxThreads.mailboxId, mailboxId),
				exp ? undefined : isNotNull(mailboxThreads.expiresAt),
			),
		);
}

// Curseur deltaFetch du dossier d'arrivee (cf. cursorAtTop / destCursorAfterMove) : lu avant le
// MOVE, pose une seule fois en fin d'operation, en compare-and-set depuis cette valeur. Le tout
// sous le verrou de la connexion IMAP que deltaFetch partage (imapInstances) : il ne lit ni
// n'ecrit ce curseur pendant le deplacement.
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
