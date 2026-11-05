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

	const applied = () =>
		db
			.select()
			.from(mailboxThreadLabels)
			.where(and(eq(mailboxThreadLabels.threadId, f.thread.id), eq(mailboxThreadLabels.labelId, label.id)));

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

	threw = false;
	try {
		await processRules({ messageId: f.message.id });
	} catch {
		threw = true;
	}
	assert(!threw, "second passage : pas d'erreur sur la cle primaire deja prise");
	assert((await applied()).length === 1, "second passage : toujours une seule ligne");

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
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
