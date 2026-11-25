// Contrats gelés du nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT0) : table
// cleanup_rules (migration ss2i_012), constantes de @common, champ cleanupRuleId du job de move.
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { cleanupRules, db, identities, workspaceIdentityMembers } from "@db";
import {
	CLEANUP_ALLOWED_KINDS,
	CLEANUP_BATCH,
	CLEANUP_MAX_DAYS,
	CLEANUP_MAX_JOBS_PER_TICK,
	CLEANUP_MAX_PAGES,
	CLEANUP_MAX_RULES_PER_IDENTITY,
	CLEANUP_MIN_DAYS,
	CLEANUP_PREVIEW_CAP,
	CLEANUP_PRESETS,
} from "@common";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..");

// Vrai si l'insertion est refusee par la base (contrainte, doublon, RLS).
async function refused(run: () => Promise<unknown>): Promise<boolean> {
	try {
		await run();
		return false;
	} catch {
		return true;
	}
}

async function main() {
	// Constantes du paragraphe 2.
	assert(JSON.stringify(CLEANUP_ALLOWED_KINDS) === JSON.stringify(["inbox", "archive", "custom"]), "CLEANUP_ALLOWED_KINDS");
	assert(
		JSON.stringify(CLEANUP_PRESETS.map((p) => p.days)) === JSON.stringify([7, 30, 91, 182, 365, 730]),
		"CLEANUP_PRESETS : 7, 30, 91, 182, 365, 730 jours",
	);
	assert(
		CLEANUP_MIN_DAYS === 1 &&
			CLEANUP_MAX_DAYS === 3650 &&
			CLEANUP_BATCH === 200 &&
			CLEANUP_MAX_JOBS_PER_TICK === 10 &&
			CLEANUP_MAX_PAGES === 40 &&
			CLEANUP_PREVIEW_CAP === 2000 &&
			CLEANUP_MAX_RULES_PER_IDENTITY === 50,
		"constantes de débit et de bornes",
	);

	// Le job de move déclare cleanupRuleId (type seulement : le champ n'est pas encore lu).
	const moveSrc = readFileSync(join(root, "apps/worker/lib/imap/imap-move.ts"), "utf8");
	assert(/type MoveJob = \{[\s\S]*?cleanupRuleId\?: string;[\s\S]*?\n\};/.test(moveSrc), "MoveJob déclare cleanupRuleId?: string");

	// Migration jouée une seconde fois : aucune erreur (idempotente).
	const migration = readFileSync(join(root, "db/init/migrations/ss2i_012_migration.sql"), "utf8");
	let replayed = true;
	try {
		await db.execute(sql.raw(migration));
	} catch (err) {
		console.error(err);
		replayed = false;
	}
	assert(replayed, "ss2i_012 rejouée sans erreur");

	const a = await createUserFixture("cleanup-contract-a");
	const b = await createUserFixture("cleanup-contract-b");
	const rule = (over: Record<string, unknown> = {}) => ({
		ownerId: a.user.id,
		identityId: a.identity.id,
		query: "newsletter",
		retentionDays: 30,
		...over,
	});

	// Contraintes de la table.
	assert(!(await refused(() => db.insert(cleanupRules).values(rule()))), "règle valide acceptée");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "autre", retentionDays: 0 }))), "retention_days 0 refusé");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "autre", retentionDays: 3651 }))), "retention_days 3651 refusé");
	assert(!(await refused(() => db.insert(cleanupRules).values(rule({ query: "un an", retentionDays: 3650 })))), "retention_days 3650 accepté");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "ab" }))), "requête de 2 caractères refusée");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "  a  " }))), "requête de 1 caractère entourée d'espaces refusée");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "*" }))), "requête * refusée");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "x".repeat(201) }))), "requête de 201 caractères refusée");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ query: "  NewsLetter  ", retentionDays: 90 }))), "doublon de portée (casse, espaces) refusé");
	assert(!(await refused(() => db.insert(cleanupRules).values(rule({ hasAttachment: true })))), "même texte avec pièce jointe : autre portée");
	assert(!(await refused(() => db.insert(cleanupRules).values(rule({ mailboxId: a.inbox.id })))), "même texte sur un dossier : autre portée");
	assert(await refused(() => db.insert(cleanupRules).values(rule({ mailboxId: a.inbox.id }))), "doublon de portée sur un dossier refusé");
	const first = (await db.select().from(cleanupRules).where(eq(cleanupRules.identityId, a.identity.id))).find((r) => !r.hasAttachment && !r.mailboxId);
	assert(
		!!first && first.paused === false && first.onlyUnread === false && first.trashedCount === 0 && first.lastRunAt === null && first.lastTrashedAt === null,
		"valeurs par défaut : pas en pause, compteur à 0, jamais passée",
	);

	// RLS : sous le rôle kurrier, un autre utilisateur ne crée rien sur l'identité d'autrui et ne voit rien.
	// Le collègue b est membre de l'identité de a (elle lui est donc visible sous RLS) sans en être propriétaire,
	// et le propriétaire est membre de sa propre identité comme le fait l'interface.
	await db.insert(workspaceIdentityMembers).values([
		{ workspaceId: a.workspace.id, identityId: a.identity.id, userId: a.user.id },
		{ workspaceId: a.workspace.id, identityId: a.identity.id, userId: b.user.id },
		{ workspaceId: b.workspace.id, identityId: b.identity.id, userId: b.user.id },
	]);
	const asUser = async (userId: string, workspaceId: string, run: (tx: any) => Promise<any>): Promise<any[]> =>
		db.transaction(async (tx) => {
			await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
			await tx.execute(sql`select set_config('request.jwt.claim.workspace_id', ${workspaceId}, true)`);
			await tx.execute(sql`set local role kurrier`);
			return run(tx);
		});
	const seen = await asUser(b.user.id, a.workspace.id, (tx) => tx.select().from(cleanupRules));
	assert(seen.length === 0, "RLS : SELECT vide pour un collègue membre de l'identité");
	const visible = await asUser(b.user.id, a.workspace.id, (tx) => tx.select().from(identities).where(eq(identities.id, a.identity.id)));
	assert(visible.length === 1, "RLS : l'identité de a est bien visible du collègue (le refus ci-dessous vient de la règle)");
	assert(
		await refused(() =>
			asUser(b.user.id, a.workspace.id, (tx) => tx.insert(cleanupRules).values(rule({ ownerId: b.user.id, query: "intrus" }))),
		),
		"RLS : INSERT refusé sur l'identité d'autrui, même visible et avec son propre owner_id",
	);
	assert(
		await refused(() => asUser(b.user.id, a.workspace.id, (tx) => tx.insert(cleanupRules).values(rule({ query: "usurpation" })))),
		"RLS : INSERT refusé avec l'owner_id d'autrui",
	);
	const deleted = await asUser(b.user.id, a.workspace.id, (tx) =>
		tx.delete(cleanupRules).where(eq(cleanupRules.identityId, a.identity.id)).returning(),
	);
	assert(deleted.length === 0, "RLS : DELETE sans effet pour un autre utilisateur");
	const own = await asUser(a.user.id, a.workspace.id, (tx) => tx.select().from(cleanupRules).where(eq(cleanupRules.identityId, a.identity.id)));
	assert(own.length === 4, "RLS : le propriétaire voit ses règles");
	assert(
		!(await refused(() =>
			asUser(b.user.id, b.workspace.id, (tx) =>
				tx.insert(cleanupRules).values({ ownerId: b.user.id, identityId: b.identity.id, query: "legitime", retentionDays: 7 }),
			),
		)),
		"RLS : INSERT accepté sur sa propre identité",
	);

	// Suppression de l'identité -> règles supprimées.
	const [lone] = await db
		.insert(identities)
		.values({ ownerId: a.user.id, workspaceId: a.workspace.id, kind: "email", value: `lone-${Date.now()}@test.invalid`, status: "verified" })
		.returning();
	await db.insert(cleanupRules).values(rule({ identityId: lone.id, query: "orpheline" }));
	await db.delete(identities).where(eq(identities.id, lone.id));
	const left = await db.select().from(cleanupRules).where(eq(cleanupRules.identityId, lone.id));
	assert(left.length === 0, "suppression de l'identité : règle supprimée");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
