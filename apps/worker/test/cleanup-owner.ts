// Propriete des regles de nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT2) :
// resolveCleanupScope, loadCleanupRule et insertCleanupRule (@common, cleanup-store.ts) tournent sans
// RLS (worker, MCP). Seul le PROPRIETAIRE de l'identite cree une regle, jamais un collegue qui la voit
// (partagee, de domaine, ou dans laquelle il a cree un dossier) ; le dossier appartient a l'identite et
// est nettoyable ; le scope est toujours relu en base (GHSA-cvh9-93mg-xvc9, commit 29091854).
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { cleanupRules, db, identities, mailboxes, workspaceIdentityMembers, workspaceMembers } from "@db";
import { insertCleanupRule, loadCleanupRule, resolveCleanupScope } from "@common";
import { and, eq, sql } from "drizzle-orm";

const sorted = (ids: string[]) => JSON.stringify([...ids].sort());

async function main() {
	const a = await createUserFixture("cleanup-owner-a");
	const b = await createUserFixture("cleanup-owner-b");

	// Dossiers en plus de l'Inbox, des Envoyes et des Brouillons de la fixture. Le dossier « colleague »
	// est cree par b dans l'identite de a : il est a l'identite, b n'en tire aucun droit.
	const box = async (identityId: string, kind: any, slug: string, ownerId = a.user.id) => {
		const [row] = await db
			.insert(mailboxes)
			.values({ ownerId, workspaceId: a.workspace.id, identityId, kind, name: slug, slug, isDefault: false, metaData: {} })
			.returning();
		return row;
	};
	const archive = await box(a.identity.id, "archive", "archive");
	const factures = await box(a.identity.id, "custom", "factures");
	const colleague = await box(a.identity.id, "custom", "colleague", b.user.id);
	const trash = await box(a.identity.id, "trash", "trash");
	const spam = await box(a.identity.id, "spam", "spam");
	const outbox = await box(a.identity.id, "outbox", "outbox");
	const cleanable = [a.inbox.id, archive.id, factures.id, colleague.id];
	const refusedBoxes = { envoyes: a.sent.id, brouillons: a.drafts.id, corbeille: trash.id, spam: spam.id, sortie: outbox.id, autre: b.inbox.id };

	// b est collegue : membre du workspace de a, identite de a partagee et dont il est membre, et une
	// identite de domaine de a (visible de tout le workspace sous RLS).
	await db.update(identities).set({ sharedWithWorkspace: true }).where(eq(identities.id, a.identity.id));
	await db.insert(workspaceMembers).values({ workspaceId: a.workspace.id, userId: b.user.id });
	await db.insert(workspaceIdentityMembers).values([
		{ workspaceId: a.workspace.id, identityId: a.identity.id, userId: a.user.id },
		{ workspaceId: a.workspace.id, identityId: a.identity.id, userId: b.user.id },
	]);
	const newIdentity = async (kind: "email" | "domain", tag: string) => {
		const [row] = await db
			.insert(identities)
			.values({ ownerId: a.user.id, workspaceId: a.workspace.id, kind, value: `${tag}-${Date.now()}.test.invalid`, status: "verified" })
			.returning();
		const [inbox] = await db
			.insert(mailboxes)
			.values({ ownerId: a.user.id, workspaceId: a.workspace.id, identityId: row.id, kind: "inbox", name: "Inbox", slug: "inbox", isDefault: true, metaData: {} })
			.returning();
		return { identity: row, inbox };
	};
	const domain = await newIdentity("domain", "cleanup-domain");

	const rulesOf = (identityId: string) => db.select().from(cleanupRules).where(eq(cleanupRules.identityId, identityId));
	const input = (over: Record<string, unknown> = {}) => ({
		ownerId: a.user.id,
		identityId: a.identity.id,
		mailboxId: null as string | null,
		query: "newsletter",
		hasAttachment: false,
		onlyUnread: false,
		retentionDays: 30,
		...over,
	});

	console.log("# resolveCleanupScope : relu en base, proprietaire seulement, dossiers nettoyables seulement");
	const all = await resolveCleanupScope(db, { ownerId: a.user.id, identityId: a.identity.id, mailboxId: null });
	assert(
		!!all && all.identityId === a.identity.id && all.identityPublicId === a.identity.publicId && all.workspacePublicId === a.workspace.publicId,
		"proprietaire : identite et workspace relus en base",
	);
	assert(!!all && Array.isArray(all.mailboxIds) && sorted(all.mailboxIds) === sorted(cleanable), "tous les dossiers : Inbox, Archive et dossiers perso, rien d'autre");
	const onlyInbox = await resolveCleanupScope(db, { ownerId: a.user.id, identityId: a.identity.id, mailboxId: a.inbox.id });
	assert(!!onlyInbox && sorted(onlyInbox.mailboxIds) === sorted([a.inbox.id]), "dossier courant : l'Inbox seule");
	for (const [name, id] of Object.entries(refusedBoxes)) {
		assert((await resolveCleanupScope(db, { ownerId: a.user.id, identityId: a.identity.id, mailboxId: id })) === null, `dossier ${name} refusé`);
	}
	assert((await resolveCleanupScope(db, { ownerId: b.user.id, identityId: a.identity.id, mailboxId: null })) === null, "collègue sur l'identité partagée : null");
	assert((await resolveCleanupScope(db, { ownerId: b.user.id, identityId: a.identity.id, mailboxId: colleague.id })) === null, "collègue sur son propre dossier dans l'identité de a : null");
	assert((await resolveCleanupScope(db, { ownerId: b.user.id, identityId: domain.identity.id, mailboxId: null })) === null, "collègue sur l'identité de domaine : null");
	assert((await resolveCleanupScope(db, { ownerId: a.user.id, identityId: "pas-un-uuid", mailboxId: null })) === null, "identité qui n'est pas un UUID : null sans erreur");
	assert((await resolveCleanupScope(db, { ownerId: a.user.id, identityId: a.identity.id, mailboxId: "pas-un-uuid" })) === null, "dossier qui n'est pas un UUID : null sans erreur");

	console.log("# insertCleanupRule : un collegue ne cree rien");
	for (const [label, over] of [
		["identité partagée", { ownerId: b.user.id }],
		["dossier créé par le collègue dans l'identité", { ownerId: b.user.id, mailboxId: colleague.id }],
		["identité de domaine", { ownerId: b.user.id, identityId: domain.identity.id }],
	] as const) {
		const res = await insertCleanupRule(db, input(over));
		assert(!res.ok && res.reason === "forbidden", `collègue, ${label} : refus typé`);
	}
	assert((await rulesOf(a.identity.id)).length === 0 && (await rulesOf(domain.identity.id)).length === 0, "collègue : zéro ligne créée");

	console.log("# insertCleanupRule : dossier de l'identite et nettoyable");
	for (const [name, id] of Object.entries(refusedBoxes)) {
		const res = await insertCleanupRule(db, input({ mailboxId: id }));
		assert(!res.ok && res.reason === "forbidden", `dossier ${name} refusé`);
	}
	assert((await rulesOf(a.identity.id)).length === 0, "dossiers refusés : zéro ligne");

	console.log("# insertCleanupRule : saisie invalide, refus type sans erreur de la base");
	for (const query of ["", "ab", "*", "-banque", "a b c"]) {
		const res = await insertCleanupRule(db, input({ query }));
		assert(!res.ok && res.reason === "query", `requête ${JSON.stringify(query)} refusée`);
	}
	for (const retentionDays of [0, 3651, 1.5, Number.NaN]) {
		const res = await insertCleanupRule(db, input({ retentionDays }));
		assert(!res.ok && res.reason === "retention", `durée ${retentionDays} refusée`);
	}
	for (const over of [{ identityId: "pas-un-uuid" }, { mailboxId: "pas-un-uuid" }, { ownerId: "pas-un-uuid" }]) {
		const res = await insertCleanupRule(db, input(over));
		assert(!res.ok && res.reason === "forbidden", `identifiant invalide ${JSON.stringify(over)} : refus typé`);
	}
	assert((await rulesOf(a.identity.id)).length === 0, "saisies invalides : zéro ligne");

	console.log("# insertCleanupRule : creation par le proprietaire, puis loadCleanupRule");
	const created = await insertCleanupRule(db, input({ query: "  Relevé de compte  " }));
	assert(created.ok, "règle tous dossiers créée");
	if (!created.ok) throw new Error("création impossible, suite inutile");
	const rule = created.rule;
	assert(
		rule.query === "Relevé de compte" && rule.ownerId === a.user.id && rule.identityId === a.identity.id && rule.mailboxId === null && rule.retentionDays === 30 && rule.paused === false,
		"requête enregistrée passée au trim(), propriétaire et identité posés",
	);
	const ctx = await loadCleanupRule(db, rule.id);
	assert(
		!!ctx &&
			ctx.ruleId === rule.id &&
			ctx.ownerId === a.user.id &&
			ctx.identityId === a.identity.id &&
			ctx.identityPublicId === a.identity.publicId &&
			ctx.workspacePublicId === a.workspace.publicId &&
			ctx.query === "Relevé de compte" &&
			ctx.retentionDays === 30 &&
			ctx.hasAttachment === false &&
			ctx.onlyUnread === false &&
			ctx.paused === false,
		"loadCleanupRule : contexte relu en base",
	);
	assert(!!ctx && Array.isArray(ctx.mailboxIds) && sorted(ctx.mailboxIds) === sorted(cleanable), "loadCleanupRule : tous les dossiers nettoyables, rien d'autre");
	for (const [label, id] of [["Inbox", a.inbox.id], ["Archive", archive.id], ["dossier perso du collègue", colleague.id]] as const) {
		const res = await insertCleanupRule(db, input({ mailboxId: id, onlyUnread: true }));
		const one = res.ok ? await loadCleanupRule(db, res.rule.id) : null;
		assert(!!one && one.onlyUnread && sorted(one.mailboxIds) === sorted([id]), `règle sur ${label} : ce dossier seul`);
	}

	console.log("# doublon : une seule ligne, duree mise a jour, pause levee");
	await db.update(cleanupRules).set({ paused: true }).where(eq(cleanupRules.id, rule.id));
	const paused = await loadCleanupRule(db, rule.id);
	assert(!!paused && paused.paused === true, "règle en pause : contexte rendu avec paused");
	const again = await insertCleanupRule(db, input({ query: "relevé DE compte", retentionDays: 91 }));
	assert(again.ok && again.rule.id === rule.id && again.rule.retentionDays === 91 && again.rule.paused === false, "doublon : même règle, 91 jours, plus en pause");
	const same = (await rulesOf(a.identity.id)).filter((r) => r.mailboxId === null && !r.hasAttachment && !r.onlyUnread);
	assert(same.length === 1 && same[0].retentionDays === 91, "doublon : une seule ligne en base");
	const tabbed = await insertCleanupRule(db, input({ query: "\t Relevé de compte\r\n", retentionDays: 182 }));
	assert(tabbed.ok && tabbed.rule.id === rule.id && tabbed.rule.query === "Relevé de compte" && tabbed.rule.retentionDays === 182, "doublon avec tabulation et saut de ligne autour : même règle");

	console.log("# proprietaire non membre de sa propre identite non partagee");
	const lone = await newIdentity("email", "cleanup-lone");
	const loneRes = await insertCleanupRule(db, input({ identityId: lone.identity.id }));
	assert(loneRes.ok, "sans RLS, la propriété suffit (pas la visibilité)");

	console.log("# plafond par identite, doublon toujours accepte au plafond");
	const capped = await newIdentity("email", "cleanup-cap");
	await db.insert(cleanupRules).values(
		Array.from({ length: 50 }, (_, n) => ({ ownerId: a.user.id, identityId: capped.identity.id, query: `regle ${String(n).padStart(3, "0")}`, retentionDays: 30 })),
	);
	const over = await insertCleanupRule(db, input({ identityId: capped.identity.id, query: "regle 050" }));
	assert(!over.ok && over.reason === "limit", "51e règle refusée (plafond)");
	const atCap = await insertCleanupRule(db, input({ identityId: capped.identity.id, query: "REGLE 000", retentionDays: 182 }));
	assert(atCap.ok && atCap.rule.retentionDays === 182, "au plafond, une règle existante reçoit sa nouvelle durée");
	assert((await rulesOf(capped.identity.id)).length === 50, "plafond : toujours 50 lignes");

	console.log("# lignes forgees en base : jamais un dossier hors allow-list ni d'une autre identite");
	const forge = async (mailboxId: string, query: string) =>
		(await db.insert(cleanupRules).values({ ownerId: a.user.id, identityId: a.identity.id, mailboxId, query, retentionDays: 30 }).returning())[0];
	for (const [name, id] of Object.entries(refusedBoxes)) {
		const forged = await loadCleanupRule(db, (await forge(id, `forge ${name}`)).id);
		assert(!!forged && Array.isArray(forged.mailboxIds) && forged.mailboxIds.length === 0, `règle forgée sur ${name} : aucun dossier`);
	}
	assert((await loadCleanupRule(db, "pas-un-uuid")) === null, "loadCleanupRule : identifiant qui n'est pas un UUID -> null");
	assert((await loadCleanupRule(db, "00000000-0000-0000-0000-000000000001")) === null, "loadCleanupRule : règle inconnue -> null");

	console.log("# l'identite change de proprietaire");
	const moved = await newIdentity("email", "cleanup-moved");
	const movedRes = await insertCleanupRule(db, input({ identityId: moved.identity.id }));
	assert(movedRes.ok && !!(await loadCleanupRule(db, movedRes.rule.id)), "avant : règle chargée");
	await db.update(identities).set({ ownerId: b.user.id }).where(eq(identities.id, moved.identity.id));
	assert(movedRes.ok && (await loadCleanupRule(db, movedRes.rule.id)) === null, "après : loadCleanupRule rend null");
	assert((await resolveCleanupScope(db, { ownerId: a.user.id, identityId: moved.identity.id, mailboxId: null })) === null, "après : l'ancien propriétaire ne résout plus l'identité");
	await db.update(cleanupRules).set({ paused: true }).where(eq(cleanupRules.id, movedRes.ok ? movedRes.rule.id : ""));
	const takeover = await insertCleanupRule(db, input({ ownerId: b.user.id, identityId: moved.identity.id, retentionDays: 91 }));
	assert(
		takeover.ok && movedRes.ok && takeover.rule.id === movedRes.rule.id && takeover.rule.ownerId === b.user.id && takeover.rule.retentionDays === 91 && takeover.rule.paused === false,
		"nouveau propriétaire, même portée : reprend la ligne de l'ancien (owner_id, durée, pause levée)",
	);
	const taken = takeover.ok ? await loadCleanupRule(db, takeover.rule.id) : null;
	assert(!!taken && taken.ownerId === b.user.id && taken.retentionDays === 91, "la règle reprise est chargée pour le nouveau propriétaire");
	assert((await rulesOf(moved.identity.id)).filter((r) => r.mailboxId === null && !r.hasAttachment && !r.onlyUnread).length === 1, "une seule ligne sur cette portée");
	const unrelated = await insertCleanupRule(db, input({ ownerId: a.user.id, identityId: moved.identity.id, query: "ancien propriétaire" }));
	assert(!unrelated.ok && unrelated.reason === "forbidden", "l'ancien propriétaire ne crée plus rien sur l'identité");
	const fresh = await insertCleanupRule(db, input({ ownerId: b.user.id, identityId: moved.identity.id, query: "autre recherche" }));
	assert(fresh.ok && !!(await loadCleanupRule(db, fresh.rule.id)), "nouveau propriétaire : autre portée créée et chargée");

	console.log("# meme fonction dans une transaction RLS (rlsClient du web)");
	const asUser = async (userId: string, run: (tx: any) => Promise<any>) =>
		db.transaction(async (tx) => {
			await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
			await tx.execute(sql`select set_config('request.jwt.claim.workspace_id', ${a.workspace.id}, true)`);
			await tx.execute(sql`set local role kurrier`);
			return run(tx);
		});
	const rls = await asUser(a.user.id, (tx) => insertCleanupRule(tx, input({ query: "facture rls" })));
	const rlsAgain = await asUser(a.user.id, (tx) => insertCleanupRule(tx, input({ query: "Facture RLS", retentionDays: 365 })));
	assert(rls.ok && rlsAgain.ok && rlsAgain.rule.id === rls.rule.id && rlsAgain.rule.retentionDays === 365, "sous RLS : création puis doublon par le propriétaire");
	const rlsColleague = await asUser(b.user.id, (tx) => insertCleanupRule(tx, input({ ownerId: b.user.id, query: "intrus rls" })));
	assert(!rlsColleague.ok && rlsColleague.reason === "forbidden", "sous RLS : collègue refusé sans erreur");
	const intruders = await db
		.select()
		.from(cleanupRules)
		.where(and(eq(cleanupRules.identityId, a.identity.id), eq(cleanupRules.ownerId, b.user.id)));
	assert(intruders.length === 0, "aucune règle du collègue sur l'identité de a");

	// Reprise sous RLS : l'on conflict do update exige que la ligne existante passe les USING de SELECT et
	// d'UPDATE, sinon Postgres leve une erreur au lieu de reprendre la regle de l'ancien proprietaire.
	const movedRls = await newIdentity("email", "cleanup-moved-rls");
	// Identite email non partagee : sous RLS, seuls ses membres la voient.
	await db.insert(workspaceIdentityMembers).values([
		{ workspaceId: a.workspace.id, identityId: movedRls.identity.id, userId: a.user.id },
		{ workspaceId: a.workspace.id, identityId: movedRls.identity.id, userId: b.user.id },
	]);
	const asResult = (p: Promise<any>) => p.catch((err) => ({ ok: false, reason: "error", message: String(err?.cause?.message ?? err) }));
	const orphan = await asUser(a.user.id, (tx) => insertCleanupRule(tx, input({ identityId: movedRls.identity.id, query: "reprise rls" })));
	const orphan2 = await asUser(a.user.id, (tx) => insertCleanupRule(tx, input({ identityId: movedRls.identity.id, query: "orphelin rls" })));
	await db.update(identities).set({ ownerId: b.user.id }).where(eq(identities.id, movedRls.identity.id));
	const rlsTakeover = await asResult(
		asUser(b.user.id, (tx) => insertCleanupRule(tx, input({ ownerId: b.user.id, identityId: movedRls.identity.id, query: "Reprise RLS", retentionDays: 91 }))),
	);
	assert(
		orphan.ok && rlsTakeover.ok && rlsTakeover.rule.id === orphan.rule.id && rlsTakeover.rule.ownerId === b.user.id && rlsTakeover.rule.retentionDays === 91,
		`sous RLS : le nouveau propriétaire de l'identité reprend la règle de l'ancien${rlsTakeover.ok ? "" : ` (${rlsTakeover.message})`}`,
	);
	const seenByOld = await asUser(a.user.id, (tx) => tx.select().from(cleanupRules).where(eq(cleanupRules.identityId, movedRls.identity.id)));
	assert(orphan2.ok && seenByOld.length === 1 && seenByOld[0].id === orphan2.rule.id, "sous RLS : l'ancien propriétaire ne voit plus que sa règle orpheline");
	const pauseOrphan = await asResult(
		asUser(b.user.id, (tx) => tx.update(cleanupRules).set({ paused: true }).where(eq(cleanupRules.id, orphan2.ok ? orphan2.rule.id : "")).returning()),
	);
	const deleteOrphan = await asUser(b.user.id, (tx) => tx.delete(cleanupRules).where(eq(cleanupRules.id, orphan2.ok ? orphan2.rule.id : "")).returning());
	const [orphanRow] = await db.select().from(cleanupRules).where(eq(cleanupRules.id, orphan2.ok ? orphan2.rule.id : ""));
	assert(
		(!Array.isArray(pauseOrphan) || pauseOrphan.length === 0) && deleteOrphan.length === 0 && !!orphanRow && orphanRow.ownerId === a.user.id && !orphanRow.paused,
		"sous RLS : le nouveau propriétaire ne met en pause ni ne supprime une règle orpheline sans la reprendre",
	);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
