"use server";
// ss2i : nettoyage automatique depuis une recherche (docs/plans/nettoyage-auto-recherche.md, MT8). Une
// regle envoie a la Corbeille, de facon permanente et repetee, les fils qui correspondent : seul le
// proprietaire de l'identite en cree, suspend ou supprime (meme controle que addWebhook, GHSA-cvh9-93mg-xvc9),
// et rien de la portee ne vient du navigateur : identite, workspace et dossiers sont relus en base par
// resolveCleanupScope. Le compte d'avant confirmation est celui du matcher que le tick utilise
// (countStrictMatches et matchCleanup de @common), pas celui de la recherche affichee, qui tolere les
// fautes de frappe. La creation ne poste aucun job : le tick suivant s'en charge.
import Typesense from "typesense";
import { and, desc, eq } from "drizzle-orm";
import { cleanupRules, mailboxes } from "@db";
import { getServerEnv, handleAction, type FormState } from "@schema";
import {
	CLEANUP_MAX_DAYS,
	CLEANUP_MAX_PAGES,
	CLEANUP_MIN_DAYS,
	CLEANUP_PREVIEW_CAP,
	cleanupQueryError,
	countStrictMatches,
	insertCleanupRule,
	matchCleanup,
	resolveCleanupScope,
	type CleanupScope,
} from "@common";
import { revalidatePath } from "next/cache";
import { rlsClient } from "@/lib/actions/clients";
import { assertIdentityAccess, assertSignedIn, isUuid } from "@/lib/authz";

// Saisie du formulaire : jamais d'identifiant, de workspace ni de dossier, seulement ce que
// l'utilisateur voit (identite par son publicId, dossier par son slug).
export type CleanupRuleInput = {
	identityPublicId: string;
	mailboxSlug: string;
	allFolders: boolean;
	query: string;
	hasAttachment: boolean;
	onlyUnread: boolean;
	retentionDays: number;
};

export type CleanupPreview = { matching: number; dueNow: number; truncated: boolean };

export type CleanupRuleItem = {
	id: string;
	query: string;
	mailboxName: string;
	allFolders: boolean;
	hasAttachment: boolean;
	onlyUnread: boolean;
	retentionDays: number;
	paused: boolean;
	trashedCount: number;
	lastTrashedAt: Date | null;
	createdAt: Date;
};

// Meme client que select-all.ts ; la recherche stricte ne passe que par matchCleanup et countStrictMatches.
function typesenseSearch() {
	const { TYPESENSE_API_KEY, TYPESENSE_PORT, TYPESENSE_PROTOCOL, TYPESENSE_HOST } = getServerEnv();
	const client = new Typesense.Client({
		nodes: [{ host: TYPESENSE_HOST, port: Number(TYPESENSE_PORT), protocol: TYPESENSE_PROTOCOL }],
		apiKey: TYPESENSE_API_KEY,
	});
	return (params: any) => client.collections("messages").documents().search(params) as Promise<any>;
}

// Controle commun de l'apercu et de la creation, dans cet ordre : connecte, identite visible, identite
// a soi, puis seulement le dossier et la portee relus sous RLS. Leve une Error en cas de refus.
async function ownScope(input: CleanupRuleInput) {
	const user = await assertSignedIn();
	const identity = await assertIdentityAccess({ publicId: String(input?.identityPublicId ?? "") });
	if (identity.ownerId !== user.id) {
		throw new Error("Une règle de nettoyage ne se crée que sur vos propres boîtes.");
	}
	const query = String(input.query ?? "").trim();
	const queryError = cleanupQueryError(query);
	if (queryError) throw new Error(queryError);
	const retentionDays = Number(input.retentionDays);
	if (!Number.isInteger(retentionDays) || retentionDays < CLEANUP_MIN_DAYS || retentionDays > CLEANUP_MAX_DAYS) {
		throw new Error(`La durée de conservation va de ${CLEANUP_MIN_DAYS} à ${CLEANUP_MAX_DAYS} jours.`);
	}
	const rls = await rlsClient();
	let mailboxId: string | null = null;
	if (!input.allFolders) {
		const [box] = await rls((tx) =>
			tx
				.select({ id: mailboxes.id })
				.from(mailboxes)
				.where(and(eq(mailboxes.identityId, identity.id), eq(mailboxes.slug, String(input.mailboxSlug ?? ""))))
				.limit(1),
		);
		if (!box) throw new Error("Dossier introuvable.");
		mailboxId = box.id;
	}
	const target = await rls((tx) => resolveCleanupScope(tx, { ownerId: user.id, identityId: identity.id, mailboxId }));
	if (!target) throw new Error("Ce dossier ne se nettoie pas automatiquement.");
	const scope: CleanupScope = {
		...target,
		query,
		hasAttachment: Boolean(input.hasAttachment),
		onlyUnread: Boolean(input.onlyUnread),
		retentionDays,
	};
	return { user, rls, mailboxId, scope };
}

// Ce que la regle ferait : fils qui correspondent exactement (sans tolerance aux fautes) et fils qui
// partiraient au prochain passage (au plus CLEANUP_PREVIEW_CAP, truncated sinon).
export async function previewCleanupRule(input: CleanupRuleInput): Promise<FormState<CleanupPreview>> {
	return handleAction(async () => {
		const { rls, scope } = await ownScope(input);
		const search = typesenseSearch();
		// Une transaction RLS par requete SQL : aucune ne reste ouverte pendant les appels a Typesense.
		const dbh = { execute: (q: any) => rls((tx) => tx.execute(q)).then((r: any) => r?.rows ?? r) };
		const [matching, due] = await Promise.all([
			countStrictMatches({ search }, scope),
			matchCleanup({ search, dbh }, scope, { now: new Date(), limit: CLEANUP_PREVIEW_CAP, maxPages: CLEANUP_MAX_PAGES }),
		]);
		const dueNow = new Set(due.rows.map((r) => r.threadId)).size;
		return { success: true, data: { matching, dueNow, truncated: due.truncated } };
	});
}

export async function createCleanupRule(input: CleanupRuleInput): Promise<FormState<{ id: string }>> {
	return handleAction(async () => {
		const { user, rls, mailboxId, scope } = await ownScope(input);
		const res = await rls((tx) =>
			insertCleanupRule(tx, {
				ownerId: user.id,
				identityId: scope.identityId,
				mailboxId,
				query: scope.query,
				hasAttachment: scope.hasAttachment,
				onlyUnread: scope.onlyUnread,
				retentionDays: scope.retentionDays,
			}),
		);
		if (!res.ok) return { success: false, error: res.message };
		revalidatePath("/mail");
		return { success: true, data: { id: res.rule.id } };
	});
}

// Regles de l'utilisateur sur cette identite. Une identite d'autrui (partagee, de domaine) n'en rend
// aucune : les regles sont a leur auteur seul.
export async function listCleanupRules(identityPublicId: string): Promise<FormState<CleanupRuleItem[]>> {
	return handleAction(async () => {
		const user = await assertSignedIn();
		const identity = await assertIdentityAccess({ publicId: String(identityPublicId ?? "") });
		if (identity.ownerId !== user.id) return { success: true, data: [] };
		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.select({ rule: cleanupRules, mailboxName: mailboxes.name, mailboxSlug: mailboxes.slug })
				.from(cleanupRules)
				.leftJoin(mailboxes, eq(mailboxes.id, cleanupRules.mailboxId))
				.where(and(eq(cleanupRules.ownerId, user.id), eq(cleanupRules.identityId, identity.id)))
				.orderBy(desc(cleanupRules.createdAt)),
		);
		return {
			success: true,
			data: rows.map(({ rule, mailboxName, mailboxSlug }) => ({
				id: rule.id,
				query: rule.query,
				mailboxName: rule.mailboxId ? (mailboxName || mailboxSlug || "Dossier") : "Tous les dossiers",
				allFolders: !rule.mailboxId,
				hasAttachment: rule.hasAttachment,
				onlyUnread: rule.onlyUnread,
				retentionDays: rule.retentionDays,
				paused: rule.paused,
				trashedCount: rule.trashedCount,
				lastTrashedAt: rule.lastTrashedAt,
				createdAt: rule.createdAt,
			})),
		};
	});
}

// Suspendre ou reprendre : le tick ignore une regle en pause, et un job deja poste la relit sous lock.
export async function setCleanupRulePaused(ruleId: string, paused: boolean): Promise<FormState> {
	return handleAction(async () => {
		const user = await assertSignedIn();
		if (!isUuid(ruleId)) throw new Error("Règle introuvable.");
		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.update(cleanupRules)
				.set({ paused: Boolean(paused), updatedAt: new Date() })
				.where(and(eq(cleanupRules.id, ruleId), eq(cleanupRules.ownerId, user.id)))
				.returning({ id: cleanupRules.id }),
		);
		if (!rows.length) throw new Error("Règle introuvable.");
		revalidatePath("/mail");
		return { success: true };
	});
}

export async function deleteCleanupRule(ruleId: string): Promise<FormState> {
	return handleAction(async () => {
		const user = await assertSignedIn();
		if (!isUuid(ruleId)) throw new Error("Règle introuvable.");
		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.delete(cleanupRules)
				.where(and(eq(cleanupRules.id, ruleId), eq(cleanupRules.ownerId, user.id)))
				.returning({ id: cleanupRules.id }),
		);
		if (!rows.length) throw new Error("Règle introuvable.");
		revalidatePath("/mail");
		return { success: true };
	});
}
