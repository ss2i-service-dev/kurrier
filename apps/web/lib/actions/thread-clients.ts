"use server";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { revalidatePath } from "next/cache";
import { crmCompanies, db, identities, mailboxes, mailboxThreads, threadClients } from "@db";
import { getServerEnv } from "@schema";
import {
	crmCompanyUrl,
	DEFAULT_PRO_DOMAINS,
	isProIdentity,
	parseDomainList,
} from "@common/crm-match";
import { PAGE_SIZE } from "@common/mail-client";
import { attachThreadsToCompany, crmSearchCompanies, orphanThreadsPage, type PreviousClientLink, restoreThreadLinks, searchKnownCrmCompanies, upsertCrmCompanies } from "@common/server-client-link";
import { rlsClient } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { isUuid } from "@/lib/authz";

// ss2i : section « Clients » des boites pro : dossiers virtuels par societe de la CRM,
// alimentes par le worker (table thread_clients). Les identites visibles sont resolues
// par la connexion RLS (une ligne), puis les lectures passent par la connexion admin
// filtrees sur ces identites : la politique RLS de thread_clients (EXISTS par ligne)
// couterait le prix note dans fetchMailboxUnreadCounts sur des milliers de lignes.

const env = getServerEnv();
const PRO_DOMAINS = parseDomainList(env.CRM_PRO_DOMAINS, DEFAULT_PRO_DOMAINS);

export type ClientRow = {
	companyId: number;
	name: string;
	ebpCustomerId: string | null;
	threadCount: number;
	// ss2i : fils non lus du client (liste de la barre laterale seulement).
	unreadCount?: number;
	lastActivityAt: string;
};

export type IdentityClients = {
	identityId: string;
	identityPublicId: string;
	clients: ClientRow[];
};

// Le fil a encore une place hors corbeille et spam dans les dossiers de l'identite.
const liveThreadCondition = sql`EXISTS (
	SELECT 1 FROM mailbox_threads mt
	JOIN mailboxes mb ON mb.id = mt.mailbox_id
	WHERE mt.thread_id = ${threadClients.threadId}
	  AND mt.identity_id = ${threadClients.identityId}
	  AND mb.kind NOT IN ('trash', 'spam')
)`;

// ss2i : fil non lu = au moins un message non lu dans un dossier hors corbeille et spam.
const unreadThreadCondition = sql`EXISTS (
	SELECT 1 FROM mailbox_threads mt
	JOIN mailboxes mb ON mb.id = mt.mailbox_id
	WHERE mt.thread_id = ${threadClients.threadId}
	  AND mt.identity_id = ${threadClients.identityId}
	  AND mt.unread_count > 0
	  AND mb.kind NOT IN ('trash', 'spam')
)`;

// Identites pro visibles de l'utilisateur (RLS), par publicId.
const visibleProIdentities = cache(async () => {
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({
				id: identities.id,
				publicId: identities.publicId,
				value: identities.value,
				ownerId: identities.ownerId,
				workspaceId: identities.workspaceId,
			})
			.from(identities)
			.where(eq(identities.kind, "email")),
	);
	return rows.filter((i) => isProIdentity(i.value, PRO_DOMAINS));
});

async function visibleProIdentity(identityPublicId: string) {
	const list = await visibleProIdentities();
	return list.find((i) => i.publicId === identityPublicId) ?? null;
}

export async function isProIdentityPublicId(identityPublicId: string) {
	return !!(await visibleProIdentity(identityPublicId));
}

/** Clients de chaque identite pro visible, derniere activite en premier. */
export const fetchIdentityClients = cache(async (): Promise<IdentityClients[]> => {
	const idents = await visibleProIdentities();
	if (!idents.length) return [];
	const rows = await db
		.select({
			identityId: threadClients.identityId,
			companyId: threadClients.crmCompanyId,
			name: crmCompanies.name,
			ebpCustomerId: crmCompanies.ebpCustomerId,
			threadCount: sql<number>`count(*)`,
			unreadCount: sql<number>`count(*) filter (where ${unreadThreadCondition})`,
			lastActivityAt: sql<Date>`max(${threadClients.lastActivityAt})`,
		})
		.from(threadClients)
		.innerJoin(crmCompanies, eq(crmCompanies.id, threadClients.crmCompanyId))
		.where(
			and(
				inArray(threadClients.identityId, idents.map((i) => i.id)),
				eq(threadClients.detached, false),
				liveThreadCondition,
			),
		)
		.groupBy(threadClients.identityId, threadClients.crmCompanyId, crmCompanies.name, crmCompanies.ebpCustomerId)
		// ss2i : clients avec des fils non lus d'abord, puis derniere activite.
		.orderBy(
			desc(sql`(count(*) filter (where ${unreadThreadCondition})) > 0`),
			desc(sql`max(${threadClients.lastActivityAt})`),
			asc(crmCompanies.name),
		);
	return idents.map((i) => ({
		identityId: i.id,
		identityPublicId: i.publicId,
		clients: rows
			.filter((r) => r.identityId === i.id)
			.map((r) => ({
				companyId: r.companyId,
				name: r.name,
				ebpCustomerId: r.ebpCustomerId,
				threadCount: Number(r.threadCount),
				unreadCount: Number(r.unreadCount),
				lastActivityAt: new Date(r.lastActivityAt).toISOString(),
			})),
	}));
});

export type ClientInfo = ClientRow & { crmUrl: string };

/** Un client d'une identite pro visible, ou null. */
export async function fetchClient(identityPublicId: string, companyId: number): Promise<ClientInfo | null> {
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident || !Number.isInteger(companyId)) return null;
	const [row] = await db
		.select({
			name: crmCompanies.name,
			ebpCustomerId: crmCompanies.ebpCustomerId,
			threadCount: sql<number>`count(${threadClients.threadId})`,
			lastActivityAt: sql<Date | null>`max(${threadClients.lastActivityAt})`,
		})
		.from(crmCompanies)
		.leftJoin(
			threadClients,
			and(
				eq(threadClients.crmCompanyId, crmCompanies.id),
				eq(threadClients.identityId, ident.id),
				eq(threadClients.detached, false),
				liveThreadCondition,
			),
		)
		.where(eq(crmCompanies.id, companyId))
		.groupBy(crmCompanies.id, crmCompanies.name, crmCompanies.ebpCustomerId);
	if (!row) return null;
	return {
		companyId,
		name: row.name,
		ebpCustomerId: row.ebpCustomerId,
		threadCount: Number(row.threadCount),
		lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : "",
		crmUrl: crmCompanyUrl(env.CRM_URL, companyId),
	};
}

/**
 * Fils d'un client : une ligne mailbox_threads par fil (sa place la plus recente hors
 * corbeille et spam), derniere activite en premier, paginee comme un dossier.
 */
export async function fetchClientThreads(identityPublicId: string, companyId: number, page: number) {
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident || !Number.isInteger(companyId)) return { threads: [], total: 0 };
	const safePage = page && page > 0 ? page : 1;
	const base = and(
		eq(threadClients.identityId, ident.id),
		eq(threadClients.crmCompanyId, companyId),
		eq(threadClients.detached, false),
	);
	const ranked = db
		.select({
			threadId: mailboxThreads.threadId,
			mailboxId: mailboxThreads.mailboxId,
			rn: sql<number>`row_number() over (partition by ${mailboxThreads.threadId} order by ${mailboxThreads.lastActivityAt} desc, ${mailboxThreads.mailboxId})`.as("rn"),
		})
		.from(threadClients)
		.innerJoin(
			mailboxThreads,
			and(eq(mailboxThreads.threadId, threadClients.threadId), eq(mailboxThreads.identityId, threadClients.identityId)),
		)
		.innerJoin(mailboxes, and(eq(mailboxes.id, mailboxThreads.mailboxId), sql`${mailboxes.kind} NOT IN ('trash', 'spam')`))
		.where(base)
		.as("ranked");
	const [rows, [count]] = await Promise.all([
		db
			.select({ thread: mailboxThreads })
			.from(ranked)
			.innerJoin(mailboxThreads, and(eq(mailboxThreads.threadId, ranked.threadId), eq(mailboxThreads.mailboxId, ranked.mailboxId)))
			.where(eq(ranked.rn, 1))
			.orderBy(desc(mailboxThreads.lastActivityAt), desc(mailboxThreads.threadId))
			.offset((safePage - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE),
		db
			.select({ n: sql<number>`count(*)` })
			.from(threadClients)
			.where(and(base, liveThreadCondition)),
	]);
	return { threads: rows.map((r) => r.thread), total: Number(count?.n ?? 0) };
}

export type ThreadClient = { companyId: number; name: string; crmUrl: string; matchedBy: string | null };

/** Clients d'un fil ouvert dans une identite (vide pour une identite non pro). */
export async function fetchThreadClients(threadId: string, identityPublicId: string): Promise<ThreadClient[]> {
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident) return [];
	const rows = await db
		.select({ companyId: threadClients.crmCompanyId, name: crmCompanies.name, matchedBy: threadClients.matchedBy })
		.from(threadClients)
		.innerJoin(crmCompanies, eq(crmCompanies.id, threadClients.crmCompanyId))
		.where(
			and(
				eq(threadClients.threadId, threadId),
				eq(threadClients.identityId, ident.id),
				eq(threadClients.detached, false),
			),
		)
		.orderBy(asc(crmCompanies.name));
	return rows.map((r) => ({ companyId: r.companyId, name: r.name, matchedBy: r.matchedBy, crmUrl: crmCompanyUrl(env.CRM_URL, r.companyId) }));
}

/**
 * Detache un fil d'un client (rattachement par domaine errone, par exemple). La ligne
 * reste, marquee `detached` : le rattrapage ne la remet pas.
 */
export async function detachThreadClient(threadId: string, identityPublicId: string, companyId: number, path?: string) {
	const user = await isSignedIn();
	if (!user) return { success: false, error: "Not authenticated" };
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident || !Number.isInteger(companyId)) return { success: false, error: "Not found" };
	await db
		.update(threadClients)
		.set({ detached: true, updatedAt: new Date() })
		.where(
			and(
				eq(threadClients.threadId, threadId),
				eq(threadClients.identityId, ident.id),
				eq(threadClients.crmCompanyId, companyId),
			),
		);
	if (path) revalidatePath(path);
	return { success: true };
}

// ---------------------------------------------------------------------------
// ss2i : rattachement manuel (OI 10270) : glisser-deposer d'un fil sur un client de la barre
// laterale, « Rattacher a un client... » (fil ouvert, selection), dossier « Sans client ».
// Ligne thread_clients matched_by = "manual" que crm-link ne retire jamais
// (packages/common/src/thread-client-link.ts).
// ---------------------------------------------------------------------------

const MAX_LINK_THREADS = 500;

// Fils de la liste que l'utilisateur voit (RLS) dans l'identite ; les autres sont ignores.
async function visibleThreadsOfIdentity(identityId: string, threadIds: unknown): Promise<string[]> {
	const ids = Array.isArray(threadIds) ? Array.from(new Set(threadIds.filter(isUuid))).slice(0, MAX_LINK_THREADS) : [];
	if (!ids.length) return [];
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.selectDistinct({ threadId: mailboxThreads.threadId })
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.identityId, identityId), inArray(mailboxThreads.threadId, ids))),
	);
	return rows.map((r) => r.threadId);
}

export type LinkClientResult =
	| { success: true; companyId: number; name: string; linked: number; previous: PreviousClientLink[] }
	| { success: false; error: string };

/** Rattache des fils a un client a la main ; un fil detache de ce client est reactive. */
export async function linkThreadsToClient(
	identityPublicId: string,
	threadIds: string[],
	companyId: number,
): Promise<LinkClientResult> {
	const user = await isSignedIn();
	if (!user) return { success: false, error: "Not authenticated" };
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident || !Number.isInteger(companyId) || companyId <= 0) return { success: false, error: "Not found" };
	const [company] = await db
		.select({ name: crmCompanies.name })
		.from(crmCompanies)
		.where(eq(crmCompanies.id, companyId));
	if (!company) return { success: false, error: "Unknown client" };
	const ids = await visibleThreadsOfIdentity(ident.id, threadIds);
	if (!ids.length) return { success: false, error: "Conversation not found in this mailbox" };
	const previous = await attachThreadsToCompany(ident, ids, companyId);
	return { success: true, companyId, name: company.name, linked: ids.length, previous };
}

/** Annule un rattachement manuel (bouton Annuler du toast) : etat d'avant, fil par fil. */
export async function undoLinkThreadsToClient(identityPublicId: string, companyId: number, previous: PreviousClientLink[]) {
	const user = await isSignedIn();
	if (!user) return { success: false, error: "Not authenticated" };
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident || !Number.isInteger(companyId) || companyId <= 0) return { success: false, error: "Not found" };
	const valid = (Array.isArray(previous) ? previous : []).filter(
		(p) =>
			!!p &&
			isUuid(p.threadId) &&
			(p.state === "absent" || p.state === "detached" || p.state === "linked") &&
			(p.matchedBy === null || (typeof p.matchedBy === "string" && p.matchedBy.length <= 32)),
	);
	const visible = new Set(await visibleThreadsOfIdentity(ident.id, valid.map((p) => p.threadId)));
	await restoreThreadLinks(ident, companyId, valid.filter((p) => visible.has(p.threadId)));
	return { success: true };
}

export type CompanySearchHit = { companyId: number; name: string; ebpCustomerId: string | null; threadCount: number };

/**
 * Societes pour « Rattacher a un client... » : toute la CRM (nom, adresse ou domaine, voir
 * crm-api.ts), completee par les societes deja connues ; sans saisie, les clients recents
 * de l'identite. Les societes trouvees dans la CRM sont inserees ou actualisees dans
 * crm_companies : le rattachement ne vise qu'une societe de cette table.
 */
export async function searchCrmCompanies(identityPublicId: string, query: string): Promise<CompanySearchHit[]> {
	const user = await isSignedIn();
	if (!user) return [];
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident) return [];
	const q = String(query ?? "").trim().slice(0, 200);
	let hits: { id: number; name: string; ebpCustomerId: string | null }[];
	if (q.length < 2) {
		hits = await db
			.select({ id: crmCompanies.id, name: crmCompanies.name, ebpCustomerId: crmCompanies.ebpCustomerId })
			.from(threadClients)
			.innerJoin(crmCompanies, eq(crmCompanies.id, threadClients.crmCompanyId))
			.where(and(eq(threadClients.identityId, ident.id), eq(threadClients.detached, false)))
			.groupBy(crmCompanies.id, crmCompanies.name, crmCompanies.ebpCustomerId)
			.orderBy(desc(sql`max(${threadClients.lastActivityAt})`))
			.limit(12);
	} else {
		const fromCrm = await crmSearchCompanies({ crmUrl: env.CRM_URL, token: env.CRM_LORE_TOKEN }, q, 20);
		await upsertCrmCompanies(fromCrm);
		const known = await searchKnownCrmCompanies(q, 20);
		const byId = new Map<number, (typeof known)[number]>();
		for (const c of [...fromCrm, ...known]) if (!byId.has(c.id)) byId.set(c.id, c);
		hits = [...byId.values()].slice(0, 20);
	}
	if (!hits.length) return [];
	const counts = await db
		.select({ companyId: threadClients.crmCompanyId, n: sql<number>`count(*)` })
		.from(threadClients)
		.where(
			and(
				eq(threadClients.identityId, ident.id),
				eq(threadClients.detached, false),
				inArray(threadClients.crmCompanyId, hits.map((h) => h.id)),
			),
		)
		.groupBy(threadClients.crmCompanyId);
	const countBy = new Map(counts.map((c) => [c.companyId, Number(c.n)]));
	return hits.map((h) => ({ companyId: h.id, name: h.name, ebpCustomerId: h.ebpCustomerId, threadCount: countBy.get(h.id) ?? 0 }));
}

/**
 * Dossier virtuel « Sans client » : fils avec une adresse exterieure humaine et sans client,
 * hors corbeille et spam, du plus recent au plus ancien, pagine comme un dossier client.
 */
export async function fetchOrphanThreads(identityPublicId: string, page: number) {
	const ident = await visibleProIdentity(identityPublicId);
	if (!ident) return { threads: [], total: 0 };
	return orphanThreadsPage(ident.id, Number(page) || 1, PAGE_SIZE);
}
