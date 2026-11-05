// Regle « ajouter une etiquette » (lib/rules/rules-processor.ts, OI 10344) : l'insertion dans
// mailbox_thread_labels porte le workspace de l'identite (colonne NOT NULL dont le defaut
// vient du JWT, NULL cote worker), un second passage ne leve pas (cle primaire deja prise),
// et la panne d'une regle ne coupe pas les suivantes. Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55460/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/rules-add-label.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, labels, mailRuleActions, mailRules, mailboxThreadLabels } from "@db";
import { and, eq } from "drizzle-orm";
import { processRules } from "../lib/rules/rules-processor";

async function main() {
	const f = await createUserFixture("regle");
	const tag = `${Date.now()}`;
	const [label] = await db
		.insert(labels)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id, name: `L-${tag}`, slug: `l-${tag}`, scope: "thread" })
		.returning();

	const [label2] = await db
		.insert(labels)
		.values({ ownerId: f.user.id, workspaceId: f.workspace.id, name: `L2-${tag}`, slug: `l2-${tag}`, scope: "thread" })
		.returning();

	const [rule] = await db
		.insert(mailRules)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			name: "etiqueter",
			priority: 2,
			match: { version: 1, logic: "all", conditions: [{ field: "subject", op: "contains", value: "secret" }] },
		})
		.returning();
	await db.insert(mailRuleActions).values({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		ruleId: rule.id,
		actionType: "add_label",
		order: 0,
		params: { labelId: label.id },
	});
	// Seconde action de la meme regle : un second passage doit la rejouer (si add_label levait sur
	// la cle primaire deja prise, l'action suivante serait sautee).
	await db.insert(mailRuleActions).values({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		ruleId: rule.id,
		actionType: "add_label",
		order: 1,
		params: { labelId: label2.id },
	});

	const appliedTo = (labelId: string) =>
		db
			.select()
			.from(mailboxThreadLabels)
			.where(and(eq(mailboxThreadLabels.threadId, f.thread.id), eq(mailboxThreadLabels.labelId, labelId)));
	const applied = () => appliedTo(label.id);

	let threw = false;
	try {
		await processRules({ messageId: f.message.id });
	} catch (err) {
		threw = true;
		console.error(err);
	}
	assert(!threw, "processRules ne leve pas (regle d'etiquette seule)");
	const rows = await applied();
	assert(rows.length === 1, "l'etiquette est posee sur le fil");
	assert(rows[0]?.workspaceId === f.workspace.id, "la ligne porte le workspace de l'identite");
	assert(rows[0]?.ownerId === f.user.id, "la ligne porte le proprietaire de la boite");

	assert((await appliedTo(label2.id)).length === 1, "la seconde action de la regle est appliquee");

	// Second passage : aucune regle en echec (journal intercepte), seconde action rejouee.
	await db.delete(mailboxThreadLabels).where(eq(mailboxThreadLabels.labelId, label2.id));
	const failures: unknown[][] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => {
		failures.push(args);
	};
	threw = false;
	try {
		await processRules({ messageId: f.message.id });
	} catch {
		threw = true;
	} finally {
		console.error = origError;
	}
	assert(!threw, "second passage : pas d'erreur sur la cle primaire deja prise");
	assert(
		!failures.some((a) => String(a[0]).includes("Rule failed")),
		"second passage : aucune regle en echec (onConflictDoNothing)",
	);
	assert((await applied()).length === 1, "second passage : toujours une seule ligne");
	assert((await appliedTo(label2.id)).length === 1, "second passage : l'action suivante est rejouee");

	// Une regle cassee (condition nulle) passe avant : les suivantes s'appliquent quand meme.
	await db.delete(mailboxThreadLabels).where(eq(mailboxThreadLabels.labelId, label.id));
	await db.insert(mailRules).values({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		identityId: f.identity.id,
		name: "cassee",
		priority: 1,
		match: { version: 1, logic: "all", conditions: [null as any] },
	});
	threw = false;
	try {
		await processRules({ messageId: f.message.id });
	} catch {
		threw = true;
	}
	assert(!threw, "une regle cassee ne fait pas lever processRules");
	assert((await applied()).length === 1, "l'etiquette est posee malgre la regle cassee qui precede");

	// « Arreter le traitement » tient meme si une action de la regle leve : la regle suivante
	// ne s'applique pas. Action qui leve : identifiant d'etiquette qui n'est pas un uuid.
	await db.delete(mailboxThreadLabels).where(eq(mailboxThreadLabels.labelId, label.id));
	const [stopRule] = await db
		.insert(mailRules)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			name: "stop en echec",
			priority: 0,
			stopProcessing: true,
			match: { version: 1, logic: "all", conditions: [{ field: "subject", op: "contains", value: "secret" }] },
		})
		.returning();
	await db.insert(mailRuleActions).values({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		ruleId: stopRule.id,
		actionType: "add_label",
		order: 0,
		params: { labelId: "pas-un-uuid" },
	});
	const failures2: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		failures2.push(args);
	};
	threw = false;
	try {
		await processRules({ messageId: f.message.id });
	} catch {
		threw = true;
	} finally {
		console.error = origError;
	}
	assert(!threw, "une regle stop dont l'action leve ne fait pas lever processRules");
	assert(
		failures2.some((a) => String(a[0]).includes("Rule failed")),
		"l'echec de la regle stop est journalise",
	);
	assert((await applied()).length === 0, "la regle suivante ne s'applique pas apres une regle stop en echec");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
