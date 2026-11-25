import { db } from "@db";
import { CLEANUP_BATCH, CLEANUP_MAX_JOBS_PER_TICK, CLEANUP_MAX_PAGES, expiryBucket, loadCleanupRule, matchCleanup } from "@common";
import { sql } from "drizzle-orm";
import type { Enqueue } from "./mail-expiry";

// ss2i : nettoyage automatique depuis une recherche (docs/plans/nettoyage-auto-recherche.md, MT6). Le
// tick mail:cleanup-tick (common-worker, toutes les 15 min) ne fait que poster des jobs mail:move op
// trash avec cleanupRuleId : moveMail relit la regle, la verrouille et revérifie chaque fil sous
// verrou (imap-move.ts), le tick n'a donc rien a garantir sur la fenetre entre les deux. Il n'ecrit
// que cleanup_rules.last_run_at : rien sur mailbox_threads (expires_at reste a l'archivage).

type Search = (params: any) => Promise<any>;

// Options d'un job de regle. jobId stable dans l'heure : BullMQ n'ajoute pas un second job tant que
// le premier attend ou tourne (une reprise apres panne, deux ticks rapproches ne l'empilent pas).
// priority : les jobs sans priorite (moves de l'utilisateur) sont pris avant (bullmq 5.63,
// moveToActive : liste wait d'abord, file prioritaire seulement quand wait est vide).
const jobOpts = (ruleId: string, mailboxId: string, now: Date) => ({
	jobId: `cleanup-${ruleId}-${mailboxId}-${expiryBucket(now)}`,
	attempts: 8,
	backoff: { type: "exponential", delay: 5000 },
	removeOnComplete: true,
	removeOnFail: { age: 604800 },
	priority: 100,
});

// Regles de la moins recemment passee a la plus recente (jamais passees d'abord). Pour chacune : la
// portee relue en base (loadCleanupRule), les fils eligibles (matchCleanup, CLEANUP_BATCH fils au plus),
// un job par dossier, puis last_run_at = now. Au plus CLEANUP_MAX_JOBS_PER_TICK jobs : les regles non
// atteintes gardent leur last_run_at et passent en tete au tick suivant. Une regle coupee par le
// plafond au milieu de ses dossiers passe quand meme en fin de rotation : sinon une regle a plus de
// 10 dossiers dus reprendrait la tete a chaque tick et affamerait les autres ; ses dossiers restants
// sont repris a son prochain tour (les jobs deja postes ont le meme jobId dans l'heure). Une erreur
// sur une regle (reponse d'erreur de Typesense, avec httpStatus) est journalisee, la regle garde son rang,
// les autres passent. Une erreur de transport (sans httpStatus : Typesense injoignable, delai depasse)
// arrete le tick : le common-worker tourne en concurrence 1 et chaque regle attendrait son propre delai
// (~10 s) ; les regles gardent leur rang et repassent au tick suivant.
// Le plafond compte les jobs postes, pas ceux qui ajoutent quelque chose : un enqueue sans effet (jobId
// deja present, BullMQ ne cree rien) consomme quand meme un des CLEANUP_MAX_JOBS_PER_TICK.
export async function runCleanupTick({ now, enqueue, search }: { now: Date; enqueue: Enqueue; search: Search }) {
	// Erreur venue de Typesense sans httpStatus : transport. Les erreurs SQL ne passent pas par ici.
	let transportDown = false;
	const guarded: Search = async (params) => {
		try {
			return await search(params);
		} catch (err: any) {
			if (err?.httpStatus == null) transportDown = true;
			throw err;
		}
	};
	// Seul l'identifiant vient de cette lecture, et seulement si l'auteur possede toujours l'identite ;
	// loadCleanupRule refait la jointure de propriete et relit portee, requete et pause.
	const due = (await db.execute(sql`
		select r.id from cleanup_rules r
		join identities i on i.id = r.identity_id and i.owner_id = r.owner_id
		where not r.paused
		order by r.last_run_at nulls first, r.id
	`)) as any[];
	let rules = 0;
	let jobs = 0;
	for (const d of due) {
		if (jobs >= CLEANUP_MAX_JOBS_PER_TICK) break;
		const ruleId = String(d.id);
		try {
			const rule = await loadCleanupRule(db, ruleId);
			if (!rule || rule.paused) continue;
			const { rows, truncated } = await matchCleanup({ search: guarded, dbh: db }, rule, {
				now,
				limit: CLEANUP_BATCH,
				maxPages: CLEANUP_MAX_PAGES,
			});
			const byBox = new Map<string, string[]>();
			for (const r of rows) byBox.set(r.mailboxId, [...(byBox.get(r.mailboxId) ?? []), r.threadId]);
			// Moins de CLEANUP_BATCH fils mais tronque : les CLEANUP_MAX_PAGES pages de candidats sont
			// epuisees (candidats ineligibles en tete de l'index). matchCleanup repart de la page 1 a chaque
			// tick : les fils au-dela ne sont pas examines tant que la tete de l'index ne change pas.
			// Identifiant seul, jamais le texte cherche.
			if (truncated && new Set(rows.map((r) => r.threadId)).size < CLEANUP_BATCH) {
				console.warn(`[mail:cleanup-tick] regle ${ruleId} : ${CLEANUP_MAX_PAGES} pages de candidats lues sans atteindre ${CLEANUP_BATCH} fils, fils suivants non examines, la regle n'avance pas tant que la tete de l'index ne change pas`);
			}
			for (const [mailboxId, ids] of byBox) {
				if (jobs >= CLEANUP_MAX_JOBS_PER_TICK) break;
				const [sync] = (await db.execute(sql`select 1 from mailbox_sync where mailbox_id = ${mailboxId}::uuid limit 1`)) as any[];
				await enqueue(
					"mail:move",
					{ threadId: ids[0], threadIds: ids, mailboxId, op: "trash", moveImap: !!sync, cleanupRuleId: rule.ruleId },
					jobOpts(rule.ruleId, mailboxId, now),
				);
				jobs++;
			}
			await db.execute(sql`update cleanup_rules set last_run_at = ${now.toISOString()}::timestamptz where id = ${ruleId}::uuid`);
			rules++;
		} catch (err: any) {
			console.error(`[mail:cleanup-tick] regle ${ruleId} : ${err?.message ?? err}`);
			if (transportDown) break;
		}
	}
	return { rules, jobs };
}
