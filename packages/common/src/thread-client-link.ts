// ss2i : section « Clients » des boites pro, rattachement MANUEL d'un fil a une societe de la
// CRM (glisser-deposer sur un client, « Rattacher a un client... », outils MCP
// link_thread_to_client et unlink_thread_from_client, OI 10270). Une ligne thread_clients
// matched_by = "manual", non detachee : crm-link (apps/worker/lib/crm/link-thread.ts) ne la
// retire jamais et ne change pas son matched_by. Ces fonctions ecrivent par la connexion
// admin : l'appelant a deja verifie l'identite et les fils (actions serveur : RLS ; MCP :
// proprietaire).
import { crmCompanies, db, mailboxes, mailboxThreads, threadClients, threadCrmScans } from "@db";
import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";

export const MANUAL_MATCH = "manual";

export type ClientLinkIdentity = { id: string; ownerId: string; workspaceId: string; publicId: string };

/** Etat d'un fil pour une societe avant un rattachement manuel (bouton Annuler). */
export type PreviousClientLink = {
	threadId: string;
	state: "absent" | "detached" | "linked";
	matchedBy: string | null;
};

export type CrmCompanyRow = { id: number; name: string; ebpCustomerId: string | null };

/**
 * Societes renvoyees par la CRM (recherche, rapprochement) : inserees ou actualisees dans
 * crm_companies, pour qu'un rattachement manuel puisse viser une societe encore sans fil.
 */
export async function upsertCrmCompanies(rows: CrmCompanyRow[]) {
	const byId = new Map<number, CrmCompanyRow>();
	for (const r of rows) {
		if (Number.isInteger(r.id) && r.id > 0 && r.name.trim() !== "") byId.set(r.id, r);
	}
	if (!byId.size) return;
	const now = new Date();
	await db
		.insert(crmCompanies)
		.values([...byId.values()].map((r) => ({ id: r.id, name: r.name.trim(), ebpCustomerId: r.ebpCustomerId, updatedAt: now })))
		.onConflictDoUpdate({
			target: crmCompanies.id,
			set: { name: sql`excluded.name`, ebpCustomerId: sql`excluded.ebp_customer_id`, updatedAt: now },
		});
}

/** Societes deja connues (crm_companies) par nom, code client EBP ou identifiant CRM. */
export async function searchKnownCrmCompanies(query: string, limit = 20): Promise<CrmCompanyRow[]> {
	const q = query.trim();
	if (!q) return [];
	const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
	const conditions = [ilike(crmCompanies.name, like), ilike(crmCompanies.ebpCustomerId, like)];
	if (/^\d{1,9}$/.test(q)) conditions.push(eq(crmCompanies.id, Number(q)));
	return db
		.select({ id: crmCompanies.id, name: crmCompanies.name, ebpCustomerId: crmCompanies.ebpCustomerId })
		.from(crmCompanies)
		.where(or(...conditions))
		// Les noms qui commencent par la saisie d'abord.
		.orderBy(sql`(lower(${crmCompanies.name}) like lower(${`${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`})) desc`, asc(crmCompanies.name))
		.limit(limit);
}

/**
 * Rattache des fils (deja verifies dans l'identite) a une societe : ligne manuelle, non
 * detachee ; un fil detache est reactive. Rend l'etat precedent de chaque fil.
 */
export async function attachThreadsToCompany(
	identity: ClientLinkIdentity,
	threadIds: string[],
	companyId: number,
): Promise<PreviousClientLink[]> {
	const ids = Array.from(new Set(threadIds));
	if (!ids.length) return [];
	return db.transaction(async (tx) => {
		const existing = await tx
			.select({ threadId: threadClients.threadId, matchedBy: threadClients.matchedBy, detached: threadClients.detached })
			.from(threadClients)
			.where(
				and(
					eq(threadClients.identityId, identity.id),
					eq(threadClients.crmCompanyId, companyId),
					inArray(threadClients.threadId, ids),
				),
			);
		const before = new Map(existing.map((r) => [r.threadId, r]));
		const activity = await tx
			.select({ threadId: mailboxThreads.threadId, last: sql<Date>`max(${mailboxThreads.lastActivityAt})` })
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.identityId, identity.id), inArray(mailboxThreads.threadId, ids)))
			.groupBy(mailboxThreads.threadId);
		const lastBy = new Map(activity.map((r) => [r.threadId, new Date(r.last)]));
		const now = new Date();
		await tx
			.insert(threadClients)
			.values(
				ids.map((threadId) => ({
					threadId,
					identityId: identity.id,
					crmCompanyId: companyId,
					ownerId: identity.ownerId,
					workspaceId: identity.workspaceId,
					identityPublicId: identity.publicId,
					matchedBy: MANUAL_MATCH,
					lastActivityAt: lastBy.get(threadId) ?? now,
					detached: false,
				})),
			)
			.onConflictDoUpdate({
				target: [threadClients.threadId, threadClients.identityId, threadClients.crmCompanyId],
				set: {
					matchedBy: MANUAL_MATCH,
					detached: false,
					lastActivityAt: sql`greatest(${threadClients.lastActivityAt}, excluded.last_activity_at)`,
					updatedAt: now,
				},
			});
		return ids.map((threadId) => {
			const b = before.get(threadId);
			return {
				threadId,
				state: !b ? "absent" : b.detached ? "detached" : "linked",
				matchedBy: b?.matchedBy ?? null,
			} as PreviousClientLink;
		});
	});
}

/** Annule un rattachement manuel : chaque fil retrouve son etat d'avant (attachThreadsToCompany). */
export async function restoreThreadLinks(identity: ClientLinkIdentity, companyId: number, previous: PreviousClientLink[]) {
	const now = new Date();
	await db.transaction(async (tx) => {
		const base = (ids: string[]) =>
			and(
				eq(threadClients.identityId, identity.id),
				eq(threadClients.crmCompanyId, companyId),
				inArray(threadClients.threadId, ids),
			);
		const absent = previous.filter((p) => p.state === "absent").map((p) => p.threadId);
		// Ligne creee par le rattachement : retiree, sauf si crm-link l'a reprise entre-temps.
		if (absent.length) await tx.delete(threadClients).where(and(base(absent), eq(threadClients.matchedBy, MANUAL_MATCH)));
		const groups = new Map<string, { detached: boolean; matchedBy: string | null; ids: string[] }>();
		for (const p of previous) {
			if (p.state === "absent") continue;
			const k = `${p.state}:${p.matchedBy ?? ""}`;
			const g = groups.get(k) ?? { detached: p.state === "detached", matchedBy: p.matchedBy, ids: [] };
			g.ids.push(p.threadId);
			groups.set(k, g);
		}
		for (const g of groups.values()) {
			await tx
				.update(threadClients)
				.set({ detached: g.detached, matchedBy: g.matchedBy, updatedAt: now })
				.where(base(g.ids));
		}
	});
}

/** Detache des fils d'une societe (ligne gardee, marquee detached : le rattrapage ne la remet pas). */
export async function detachThreadsFromCompany(identity: ClientLinkIdentity, threadIds: string[], companyId: number) {
	const ids = Array.from(new Set(threadIds));
	if (!ids.length) return 0;
	const rows = await db
		.update(threadClients)
		.set({ detached: true, updatedAt: new Date() })
		.where(
			and(
				eq(threadClients.identityId, identity.id),
				eq(threadClients.crmCompanyId, companyId),
				eq(threadClients.detached, false),
				inArray(threadClients.threadId, ids),
			),
		)
		.returning({ threadId: threadClients.threadId });
	return rows.length;
}

/**
 * Dossier virtuel « Sans client » d'une identite pro : fils avec au moins une adresse
 * exterieure humaine (thread_crm_scans, ecrit par crm-link) et aucun rattachement non
 * detache, encore presents hors corbeille et spam. Une ligne mailbox_threads par fil (sa
 * place la plus recente hors corbeille et spam), derniere activite en premier, paginee
 * comme un dossier client. Parcours de l'index partiel ix_thread_crm_scans_external.
 */
export async function orphanThreadsPage(identityId: string, page: number, pageSize: number) {
	const safePage = page && page > 0 ? Math.floor(page) : 1;
	const cond = and(
		eq(threadCrmScans.identityId, identityId),
		gt(threadCrmScans.externalAddresses, 0),
		sql`NOT EXISTS (
			SELECT 1 FROM thread_clients tc
			WHERE tc.thread_id = ${threadCrmScans.threadId}
			  AND tc.identity_id = ${threadCrmScans.identityId}
			  AND NOT tc.detached
		)`,
		sql`EXISTS (
			SELECT 1 FROM mailbox_threads mt
			JOIN mailboxes mb ON mb.id = mt.mailbox_id
			WHERE mt.thread_id = ${threadCrmScans.threadId}
			  AND mt.identity_id = ${threadCrmScans.identityId}
			  AND mb.kind NOT IN ('trash', 'spam')
		)`,
	);
	const [ids, [counted]] = await Promise.all([
		db
			.select({ threadId: threadCrmScans.threadId })
			.from(threadCrmScans)
			.where(cond)
			.orderBy(desc(threadCrmScans.lastActivityAt), desc(threadCrmScans.threadId))
			.offset((safePage - 1) * pageSize)
			.limit(pageSize),
		db.select({ n: sql<number>`count(*)` }).from(threadCrmScans).where(cond),
	]);
	const total = Number(counted?.n ?? 0);
	if (!ids.length) return { threads: [] as (typeof mailboxThreads.$inferSelect)[], total };
	const rows = await db
		.selectDistinctOn([mailboxThreads.threadId], { thread: mailboxThreads })
		.from(mailboxThreads)
		.innerJoin(mailboxes, and(eq(mailboxes.id, mailboxThreads.mailboxId), sql`${mailboxes.kind} NOT IN ('trash', 'spam')`))
		.where(and(eq(mailboxThreads.identityId, identityId), inArray(mailboxThreads.threadId, ids.map((r) => r.threadId))))
		.orderBy(mailboxThreads.threadId, desc(mailboxThreads.lastActivityAt), mailboxThreads.mailboxId);
	const byThread = new Map(rows.map((r) => [r.thread.threadId, r.thread]));
	return { threads: ids.map((r) => byThread.get(r.threadId)).filter((t) => !!t), total };
}
