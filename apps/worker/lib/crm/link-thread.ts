import { db, crmCompanies, crmEmailMatches, identities, mailboxes, mailboxThreads, messages, threadClients, threadCrmScans } from "@db";
import { and, desc, eq, gt, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { getServerEnv } from "@schema";
import { companiesOf, DEFAULT_INTERNAL_DOMAINS, DEFAULT_PRO_DOMAINS, externalAddresses, htmlToPlainLines, isProIdentity, quotedHeaderAddresses, parseDomainList, type EmailMatch } from "@common";
import { MANUAL_MATCH } from "@common/server-client-link";
import { crmConfigured, crmMatchEmail } from "./crm-client";

// ss2i : rattachement fil -> societe(s) de la CRM pour les identites pro. Deux entrees :
// linkThread (un fil, une identite : a l'arrivee d'un message) et backfillIdentity (toute
// une identite, du plus recent au plus ancien, reprenable sur son curseur range dans
// identities.meta.ss2iCrmLink). Les deux passent par le cache crm_email_matches, donc
// une passe de rattrapage dont les adresses sont a jour ne fait aucun appel CRM.

const env = getServerEnv();
const PRO_DOMAINS = parseDomainList(env.CRM_PRO_DOMAINS, DEFAULT_PRO_DOMAINS);
const INTERNAL_DOMAINS = parseDomainList(env.CRM_INTERNAL_DOMAINS, DEFAULT_INTERNAL_DOMAINS);
const days = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const MATCH_TTL_DAYS = days(env.CRM_MATCH_TTL_DAYS, 30);
export const MATCH_RETRY_DAYS = days(env.CRM_MATCH_RETRY_DAYS, 7);

/** Dossiers dont les adresses ne sont jamais soumises a la CRM. */
const IGNORED_KINDS = ["trash", "spam", "outbox"] as const;

export const BACKFILL_PAGE = 100;

export function isProIdentityValue(value: string | null | undefined) {
	return isProIdentity(value, PRO_DOMAINS);
}

export async function proIdentities() {
	const rows = await db
		.select()
		.from(identities)
		.where(eq(identities.kind, "email"));
	return rows.filter((i) => isProIdentityValue(i.value));
}

// ---------------------------------------------------------------------------
// Cache des rapprochements par adresse
// ---------------------------------------------------------------------------

type CacheRow = typeof crmEmailMatches.$inferSelect;

function isFresh(row: CacheRow, now: number): boolean {
	const ttl = (row.matched ? MATCH_TTL_DAYS : MATCH_RETRY_DAYS) * 86_400_000;
	return now - new Date(row.checkedAt).getTime() < ttl;
}

/**
 * Rapprochement de chaque adresse : cache quand il est frais, sinon la CRM (une
 * adresse par appel), resultat ecrit en cache, negatif compris. Une adresse dont la
 * CRM ne repond pas garde son ancienne valeur si elle en a une, sinon est ignoree.
 */
export async function matchAddresses(emails: string[]): Promise<EmailMatch[]> {
	if (!emails.length) return [];
	const now = Date.now();
	const cached = await db.select().from(crmEmailMatches).where(inArray(crmEmailMatches.email, emails));
	const byEmail = new Map(cached.map((r) => [r.email, r]));
	const out: EmailMatch[] = [];
	const names = new Map<number, string | null>();
	for (const email of emails) {
		const row = byEmail.get(email);
		if (row && isFresh(row, now)) {
			out.push(toMatch(row));
			continue;
		}
		const res = crmConfigured() ? await crmMatchEmail(email) : null;
		if (!res) {
			if (row) out.push(toMatch(row));
			continue;
		}
		const companyId = res.matched && res.company ? res.company.id : null;
		if (res.company) {
			names.set(res.company.id, res.company.name);
			await db
				.insert(crmCompanies)
				.values({ id: res.company.id, name: res.company.name, ebpCustomerId: res.company.ebp_customer_id, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: crmCompanies.id,
					set: { name: res.company.name, ebpCustomerId: res.company.ebp_customer_id, updatedAt: new Date() },
				});
		}
		const values = {
			email,
			matched: companyId != null,
			matchedBy: companyId != null ? res.matched_by : null,
			crmCompanyId: companyId,
			crmContactId: res.contact?.id ?? null,
			contactName: res.contact?.name ?? null,
			checkedAt: new Date(),
		};
		await db
			.insert(crmEmailMatches)
			.values(values)
			.onConflictDoUpdate({ target: crmEmailMatches.email, set: values });
		out.push({ email, matched: values.matched, matchedBy: values.matchedBy, companyId, companyName: res.company?.name ?? null });
	}
	// Noms des societes venues du cache.
	const missing = Array.from(new Set(out.filter((m) => m.companyId != null && m.companyName == null).map((m) => m.companyId!)));
	if (missing.length) {
		const rows = await db.select().from(crmCompanies).where(inArray(crmCompanies.id, missing));
		for (const r of rows) names.set(r.id, r.name);
		for (const m of out) if (m.companyId != null && m.companyName == null) m.companyName = names.get(m.companyId) ?? null;
	}
	return out;
}

function toMatch(row: CacheRow): EmailMatch {
	return { email: row.email, matched: row.matched, matchedBy: row.matchedBy, companyId: row.crmCompanyId, companyName: null };
}

// ---------------------------------------------------------------------------
// Un fil
// ---------------------------------------------------------------------------

export type LinkResult = { skipped: boolean; companies: number[]; externalAddresses: number };

/**
 * Recalcule les societes d'un fil pour une identite : adresses exterieures des
 * messages du fil ranges dans les dossiers de l'identite (hors corbeille, spam et
 * brouillons), rapprochement par adresse, lignes thread_clients mises a jour (les
 * lignes detachees a la main sont conservees telles quelles, jamais recreees ; les lignes
 * rattachees a la main, matched_by = "manual", ne sont jamais retirees ni requalifiees).
 * Le nombre d'adresses exterieures va dans thread_crm_scans (dossier « Sans client »).
 */
export async function linkThread(threadId: string, identityId: string, identity?: typeof identities.$inferSelect): Promise<LinkResult> {
	const ident = identity ?? (await db.select().from(identities).where(eq(identities.id, identityId)).then((r) => r[0]));
	if (!ident || !isProIdentityValue(ident.value)) return { skipped: true, companies: [], externalAddresses: 0 };

	const rows = await db
		.select({ from: messages.from, to: messages.to, cc: messages.cc, bcc: messages.bcc, text: messages.text, html: messages.html })
		.from(messages)
		.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
		.where(
			and(
				eq(messages.threadId, threadId),
				eq(mailboxes.identityId, identityId),
				eq(messages.draft, false),
				notInArray(mailboxes.kind, [...IGNORED_KINDS]),
			),
		);
	// En-tetes du message, puis en-tetes des messages transferes ou cites dans le corps :
	// un mail client transfere par un collegue n'a que des adresses internes en en-tete.
	const emails = externalAddresses(
		rows.flatMap((r) => [r.from, r.to, r.cc, r.bcc, quotedHeaderAddresses(r.text || (r.html ? htmlToPlainLines(r.html) : null))]),
		INTERNAL_DOMAINS,
	);
	const companies = emails.length ? companiesOf(await matchAddresses(emails)) : [];
	const ids = companies.map((c) => c.companyId);

	const [activity] = await db
		.select({ last: sql<Date | null>`max(${mailboxThreads.lastActivityAt})` })
		.from(mailboxThreads)
		.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.identityId, identityId)));
	const lastActivityAt = activity?.last ? new Date(activity.last) : new Date();

	await db.transaction(async (tx) => {
		await tx
			.insert(threadCrmScans)
			.values({ threadId, identityId, externalAddresses: emails.length, lastActivityAt, scannedAt: new Date() })
			.onConflictDoUpdate({
				target: [threadCrmScans.threadId, threadCrmScans.identityId],
				set: { externalAddresses: emails.length, lastActivityAt, scannedAt: new Date() },
			});
		// Societes qui ne correspondent plus (cache rafraichi, adresses retirees) : lignes
		// retirees, sauf celles detachees ou rattachees a la main.
		await tx
			.delete(threadClients)
			.where(
				and(
					eq(threadClients.threadId, threadId),
					eq(threadClients.identityId, identityId),
					eq(threadClients.detached, false),
					sql`${threadClients.matchedBy} IS DISTINCT FROM ${MANUAL_MATCH}`,
					ids.length ? notInArray(threadClients.crmCompanyId, ids) : sql`true`,
				),
			);
		if (!companies.length) return;
		await tx
			.insert(threadClients)
			.values(
				companies.map((c) => ({
					threadId,
					identityId,
					crmCompanyId: c.companyId,
					ownerId: ident.ownerId,
					workspaceId: ident.workspaceId,
					identityPublicId: ident.publicId,
					matchedBy: c.matchedBy,
					lastActivityAt,
				})),
			)
			.onConflictDoUpdate({
				target: [threadClients.threadId, threadClients.identityId, threadClients.crmCompanyId],
				set: {
					// Un rattachement manuel le reste, meme si les adresses menent aussi a la societe.
					matchedBy: sql`CASE WHEN ${threadClients.matchedBy} = ${MANUAL_MATCH} THEN ${MANUAL_MATCH} ELSE excluded.matched_by END`,
					lastActivityAt: sql`excluded.last_activity_at`,
					identityPublicId: sql`excluded.identity_public_id`,
					updatedAt: new Date(),
				},
			});
	});
	return { skipped: false, companies: ids, externalAddresses: emails.length };
}

// ---------------------------------------------------------------------------
// Rattrapage d'une identite
// ---------------------------------------------------------------------------

/**
 * Version des regles de rattachement : une passe de rattrapage faite avec d'autres
 * regles est refaite. 2 = adresses des en-tetes transferes ou cites dans le corps.
 * 3 = thread_crm_scans rempli pour tous les fils (dossier « Sans client »).
 */
export const LINK_RULES_VERSION = 3;

export type BackfillState = {
	rules?: number;
	cursorAt?: string | null;
	cursorThreadId?: string | null;
	startedAt?: string | null;
	doneAt?: string | null;
	processed?: number;
	linked?: number;
};

export async function readBackfillState(identityId: string): Promise<BackfillState> {
	const [row] = await db
		.select({ state: sql<BackfillState | null>`${identities.metaData} -> 'ss2iCrmLink'` })
		.from(identities)
		.where(eq(identities.id, identityId));
	return row?.state && typeof row.state === "object" && !Array.isArray(row.state) ? row.state : {};
}

// La colonne vaut le JSON `null` (defaut drizzle) tant que rien n'y est ecrit : coalesce
// ne le remplace pas, et `'null'::jsonb || objet` fabrique un tableau.
async function writeBackfillState(identityId: string, state: BackfillState) {
	await db.execute(sql`
		update identities
		set meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end)
			|| jsonb_build_object('ss2iCrmLink', ${JSON.stringify(state)}::jsonb)
		where id = ${identityId}::uuid
	`);
}

/**
 * Tous les fils d'une identite pro, du plus recent au plus ancien, par pages, curseur
 * (last_activity_at, thread_id) ecrit apres chaque page : un worker arrete reprend ou
 * il en etait. `shouldStop` permet de rendre la main proprement (arret du worker).
 */
export async function backfillIdentity(identityId: string, shouldStop: () => boolean = () => false) {
	const [ident] = await db.select().from(identities).where(eq(identities.id, identityId));
	if (!ident || !isProIdentityValue(ident.value)) return { skipped: true, processed: 0, linked: 0 };
	let state = await readBackfillState(identityId);
	if (state.doneAt || !state.startedAt || state.rules !== LINK_RULES_VERSION) {
		// Nouvelle passe : repart du haut (les adresses deja en cache ne coutent rien).
		state = { rules: LINK_RULES_VERSION, startedAt: new Date().toISOString(), cursorAt: null, cursorThreadId: null, doneAt: null, processed: 0, linked: 0 };
		await writeBackfillState(identityId, state);
	}
	let processed = state.processed ?? 0;
	let linked = state.linked ?? 0;
	for (;;) {
		if (shouldStop()) return { skipped: false, processed, linked, stopped: true };
		const cursor =
			state.cursorAt && state.cursorThreadId
				? or(
						lt(mailboxThreads.lastActivityAt, new Date(state.cursorAt)),
						and(eq(mailboxThreads.lastActivityAt, new Date(state.cursorAt)), lt(mailboxThreads.threadId, state.cursorThreadId)),
					)
				: undefined;
		// Un fil par ligne (sa place la plus recente), hors fils qui ne sont qu'en
		// corbeille ou spam (leurs expediteurs n'ont rien a faire dans le cache).
		const page = await db
			.select({
				threadId: mailboxThreads.threadId,
				lastActivityAt: sql<Date>`max(${mailboxThreads.lastActivityAt})`.as("last_activity_at"),
			})
			.from(mailboxThreads)
			.innerJoin(mailboxes, eq(mailboxes.id, mailboxThreads.mailboxId))
			.where(
				and(
					eq(mailboxThreads.identityId, identityId),
					notInArray(mailboxes.kind, [...IGNORED_KINDS]),
					cursor,
				),
			)
			.groupBy(mailboxThreads.threadId)
			.orderBy(desc(sql`max(${mailboxThreads.lastActivityAt})`), desc(mailboxThreads.threadId))
			.limit(BACKFILL_PAGE);
		if (!page.length) break;
		for (const row of page) {
			const r = await linkThread(row.threadId, identityId, ident);
			processed++;
			if (r.companies.length) linked++;
		}
		const last = page[page.length - 1];
		state = {
			...state,
			cursorAt: new Date(last.lastActivityAt).toISOString(),
			cursorThreadId: last.threadId,
			processed,
			linked,
		};
		await writeBackfillState(identityId, state);
		if (page.length < BACKFILL_PAGE) break;
	}
	state = { ...state, doneAt: new Date().toISOString(), processed, linked };
	await writeBackfillState(identityId, state);
	return { skipped: false, processed, linked, stopped: false };
}

/**
 * Identites pro dont une passe de rattrapage est due : jamais faite, interrompue,
 * plus vieille que MATCH_RETRY_DAYS, ou dont des fils sont arrives depuis (rattrapage
 * IMAP en cours : les messages du mode backfill ne passent pas par les jobs unitaires).
 */
export async function identitiesDueForBackfill() {
	const due: string[] = [];
	const retryMs = MATCH_RETRY_DAYS * 86_400_000;
	for (const ident of await proIdentities()) {
		const state = await readBackfillState(ident.id);
		if (!state.doneAt || state.rules !== LINK_RULES_VERSION) {
			due.push(ident.id);
			continue;
		}
		const doneAt = new Date(state.doneAt);
		if (Date.now() - doneAt.getTime() > retryMs) {
			due.push(ident.id);
			continue;
		}
		const [fresh] = await db
			.select({ n: sql<number>`count(*)` })
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.identityId, ident.id), gt(mailboxThreads.createdAt, doneAt)))
			.limit(1);
		if (Number(fresh?.n ?? 0) > 0) due.push(ident.id);
	}
	return due;
}

