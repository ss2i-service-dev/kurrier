import type { cleanupRules } from "@db";
import { sql } from "drizzle-orm";
import {
	CLEANUP_ALLOWED_KINDS,
	CLEANUP_MAX_DAYS,
	CLEANUP_MAX_RULES_PER_IDENTITY,
	CLEANUP_MIN_DAYS,
	cleanupQueryError,
	type CleanupRuleCtx,
	type CleanupScope,
} from "./cleanup-rules";

// ss2i : nettoyage automatique, propriete des regles (docs/plans/nettoyage-auto-recherche.md, MT2).
// Ces fonctions tournent sans RLS (worker, MCP) : la condition de propriete est dans chaque instruction
// SQL. Seul le PROPRIETAIRE de l'identite (identities.owner_id, pas celui d'un dossier : un collegue
// peut creer un dossier dans une identite partagee) cree une regle, et une regle ne vit que tant que
// son auteur possede l'identite. Identite, workspace et dossiers sont toujours relus en base, jamais
// pris dans des chaines du client (meme famille que GHSA-cvh9-93mg-xvc9, commit 29091854). Dans une
// transaction RLS (web), les policies de cleanup_rules et d'identities s'appliquent en plus.

type Dbh = { execute: (q: any) => Promise<any> };

// Partie du scope qui vient de la base ; la requete et la duree viennent de la regle ou du formulaire.
export type CleanupTarget = Pick<CleanupScope, "identityId" | "identityPublicId" | "workspacePublicId" | "mailboxIds">;

export type CleanupRuleRecord = typeof cleanupRules.$inferSelect;

export type CleanupInsertResult =
	| { ok: true; rule: CleanupRuleRecord }
	| { ok: false; reason: "query" | "retention" | "forbidden" | "limit" | "conflict"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const ZERO_UUID = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);
const kinds = `{${CLEANUP_ALLOWED_KINDS.join(",")}}`;
// Meme jeu de caracteres que la CHECK et l'index unique de ss2i_012 : l'expression de l'on conflict doit
// etre celle de l'index. Le litteral E'' porte les barres obliques, Postgres les interprete.
const TRIM = sql.raw(`E' \\t\\r\\n'`);

// Dossiers nettoyables de l'identite (allow-list), restreints a un dossier s'il est pose. Tableau vide
// plutot que null : une regle sans dossier nettoyable ne fait simplement rien.
const cleanableBoxes = (identityId: any, mailboxId: any) => sql`array(
	select m.id::text from mailboxes m
	where m.identity_id = ${identityId} and m.kind::text = any(${kinds}::text[])
	  and (${mailboxId} is null or m.id = ${mailboxId})
	order by m.id
)`;

// Scope avant creation (apercu, formulaire, MCP) : null si l'identite n'est pas a ownerId, ou si le
// dossier demande n'est pas un dossier nettoyable de cette identite. mailboxId null = tous les dossiers.
export async function resolveCleanupScope(
	dbh: Dbh,
	o: { ownerId: string; identityId: string; mailboxId?: string | null },
): Promise<CleanupTarget | null> {
	const mailboxId = o.mailboxId ?? null;
	if (!isUuid(o.ownerId) || !isUuid(o.identityId) || (mailboxId !== null && !isUuid(mailboxId))) return null;
	const rows = (await dbh.execute(sql`
		select i.id, i.public_id as identity_public_id, w.public_id as workspace_public_id,
			${cleanableBoxes(sql`i.id`, sql`${mailboxId}::uuid`)} as mailbox_ids
		from identities i
		join workspaces w on w.id = i.workspace_id
		where i.id = ${o.identityId}::uuid and i.owner_id = ${o.ownerId}::uuid
	`)) as any[];
	const r = rows[0];
	if (!r) return null;
	const mailboxIds = (r.mailbox_ids as string[]).map(String);
	if (mailboxId !== null && !mailboxIds.length) return null;
	return {
		identityId: String(r.id),
		identityPublicId: String(r.identity_public_id),
		workspacePublicId: String(r.workspace_public_id),
		mailboxIds,
	};
}

// Contexte d'une regle pour le tick et le job de move : null si elle n'existe pas ou si son identite
// n'appartient plus a son auteur. Une regle en pause est rendue (paused) : c'est a l'appelant de sortir.
export async function loadCleanupRule(dbh: Dbh, ruleId: string): Promise<CleanupRuleCtx | null> {
	if (!isUuid(ruleId)) return null;
	const rows = (await dbh.execute(sql`
		select r.id, r.owner_id, r.identity_id, r.query, r.has_attachment, r.only_unread, r.retention_days, r.paused,
			i.public_id as identity_public_id, w.public_id as workspace_public_id,
			${cleanableBoxes(sql`r.identity_id`, sql`r.mailbox_id`)} as mailbox_ids
		from cleanup_rules r
		join identities i on i.id = r.identity_id and i.owner_id = r.owner_id
		join workspaces w on w.id = i.workspace_id
		where r.id = ${ruleId}::uuid
	`)) as any[];
	const r = rows[0];
	if (!r) return null;
	return {
		ruleId: String(r.id),
		ownerId: String(r.owner_id),
		paused: Boolean(r.paused),
		identityId: String(r.identity_id),
		identityPublicId: String(r.identity_public_id),
		workspacePublicId: String(r.workspace_public_id),
		mailboxIds: (r.mailbox_ids as string[]).map(String),
		query: String(r.query),
		hasAttachment: Boolean(r.has_attachment),
		onlyUnread: Boolean(r.only_unread),
		retentionDays: Number(r.retention_days),
	};
}

const toRecord = (r: any): CleanupRuleRecord => ({
	id: String(r.id),
	ownerId: String(r.owner_id),
	identityId: String(r.identity_id),
	mailboxId: r.mailbox_id ? String(r.mailbox_id) : null,
	query: String(r.query),
	hasAttachment: Boolean(r.has_attachment),
	onlyUnread: Boolean(r.only_unread),
	retentionDays: Number(r.retention_days),
	paused: Boolean(r.paused),
	lastRunAt: r.last_run_at ? new Date(r.last_run_at) : null,
	lastTrashedAt: r.last_trashed_at ? new Date(r.last_trashed_at) : null,
	trashedCount: Number(r.trashed_count),
	createdAt: new Date(r.created_at),
	updatedAt: new Date(r.updated_at),
});

// Creation d'une regle, utilisable sans RLS : l'instruction elle-meme exige que l'identite soit a
// ownerId (zero ligne sinon) et que le dossier eventuel soit un dossier nettoyable de cette identite.
// Meme portee (identite, dossier, requete sans casse, filtres) : la duree est mise a jour et la pause
// levee. Si la ligne est celle d'un ancien proprietaire (l'identite a change de main : le tick ne
// l'executait plus), le proprietaire actuel la reprend (owner_id). Plafond de
// CLEANUP_MAX_RULES_PER_IDENTITY regles, qui ne bloque pas la mise a jour d'une regle existante.
export async function insertCleanupRule(
	dbh: Dbh,
	o: {
		ownerId: string;
		identityId: string;
		mailboxId?: string | null;
		query: string;
		hasAttachment: boolean;
		onlyUnread: boolean;
		retentionDays: number;
	},
): Promise<CleanupInsertResult> {
	const queryError = cleanupQueryError(o.query);
	if (queryError) return { ok: false, reason: "query", message: queryError };
	const days = o.retentionDays;
	if (!Number.isInteger(days) || days < CLEANUP_MIN_DAYS || days > CLEANUP_MAX_DAYS) {
		return { ok: false, reason: "retention", message: `La durée de conservation va de ${CLEANUP_MIN_DAYS} à ${CLEANUP_MAX_DAYS} jours.` };
	}
	const forbidden = { ok: false, reason: "forbidden", message: "Une règle de nettoyage ne se crée que sur vos propres boîtes." } as const;
	const mailboxId = o.mailboxId ?? null;
	if (!isUuid(o.ownerId) || !isUuid(o.identityId) || (mailboxId !== null && !isUuid(mailboxId))) return forbidden;
	// Requete enregistree passee au trim() JS, qui retire au moins ce que coupe btrim(query, TRIM) de la base.
	const query = String(o.query).trim();
	const att = Boolean(o.hasAttachment);
	const unread = Boolean(o.onlyUnread);
	const box = sql`${mailboxId}::uuid`;
	const sameScope = sql`c.identity_id = i.id
		and coalesce(c.mailbox_id, ${ZERO_UUID}) = coalesce(${box}, ${ZERO_UUID})
		and lower(btrim(c.query, ${TRIM})) = lower(btrim(${query}::text, ${TRIM}))
		and c.has_attachment = ${att}::boolean and c.only_unread = ${unread}::boolean`;

	const rows = (await dbh.execute(sql`
		insert into cleanup_rules (owner_id, identity_id, mailbox_id, query, has_attachment, only_unread, retention_days)
		select i.owner_id, i.id, ${box}, ${query}::text, ${att}::boolean, ${unread}::boolean, ${days}::integer
		from identities i
		where i.id = ${o.identityId}::uuid and i.owner_id = ${o.ownerId}::uuid
		  and (${box} is null or exists (
			select 1 from mailboxes m
			where m.id = ${box} and m.identity_id = i.id and m.kind::text = any(${kinds}::text[])
		  ))
		  and ((select count(*) from cleanup_rules c where c.identity_id = i.id) < ${CLEANUP_MAX_RULES_PER_IDENTITY}
			or exists (select 1 from cleanup_rules c where ${sameScope}))
		on conflict (identity_id, coalesce(mailbox_id, ${ZERO_UUID}), lower(btrim(query, ${TRIM})), has_attachment, only_unread)
		do update set owner_id = excluded.owner_id, retention_days = excluded.retention_days, paused = false, updated_at = now()
		where cleanup_rules.owner_id = excluded.owner_id
		   or not exists (select 1 from identities io where io.id = cleanup_rules.identity_id and io.owner_id = cleanup_rules.owner_id)
		returning *
	`)) as any[];
	if (rows[0]) return { ok: true, rule: toRecord(rows[0]) };

	// Zero ligne : l'instruction ci-dessus a decide, ces lectures ne servent qu'a dire pourquoi.
	if (!(await resolveCleanupScope(dbh, { ownerId: o.ownerId, identityId: o.identityId, mailboxId }))) return forbidden;
	const [stat] = (await dbh.execute(sql`
		select count(*)::int as n, coalesce(bool_or(${sameScope}), false) as same
		from cleanup_rules c, (select ${o.identityId}::uuid as id) i
		where c.identity_id = i.id
	`)) as any[];
	// Sans portee identique, c'est le plafond ; avec (ligne d'un autre utilisateur, invisible sous RLS),
	// c'est le conflit que le do update a refuse.
	if (!stat?.same && Number(stat?.n) >= CLEANUP_MAX_RULES_PER_IDENTITY) {
		return { ok: false, reason: "limit", message: `Une boîte compte au plus ${CLEANUP_MAX_RULES_PER_IDENTITY} règles de nettoyage.` };
	}
	return { ok: false, reason: "conflict", message: "Une règle identique existe déjà sur cette boîte, posée par un autre utilisateur." };
}
