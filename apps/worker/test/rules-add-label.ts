// "Add a label" rule (lib/rules/rules-processor.ts): the insert into mailbox_thread_labels carries the
// workspace of the identity (NOT NULL column whose default comes from the JWT, NULL on the worker side), a
// second pass does not throw (primary key already taken), and the failure of one rule does not cut the
// following ones. Test database: see mcp-test-env.ts:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55460/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/rules-add-label.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, labels, mailRuleActions, mailRules, mailboxThreadLabels } from "@db";
import { and, eq } from "drizzle-orm";
import { processRules } from "../lib/rules/rules-processor";

async function main() {
	const f = await createUserFixture("rule");
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
			name: "label",
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
	// Second action of the same rule: a second pass must replay it (if add_label threw on the primary key
	// already taken, the following action would be skipped).
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
	assert(!threw, "processRules does not throw (label rule alone)");
	const rows = await applied();
	assert(rows.length === 1, "the label is set on the thread");
	assert(rows[0]?.workspaceId === f.workspace.id, "the row carries the workspace of the identity");
	assert(rows[0]?.ownerId === f.user.id, "the row carries the owner of the mailbox");

	assert((await appliedTo(label2.id)).length === 1, "the second action of the rule is applied");

	// Second pass: no failing rule (log intercepted), second action replayed.
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
	assert(!threw, "second pass: no error on the primary key already taken");
	assert(
		!failures.some((a) => String(a[0]).includes("Rule failed")),
		"second pass: no failing rule (onConflictDoNothing)",
	);
	assert((await applied()).length === 1, "second pass: still a single row");
	assert((await appliedTo(label2.id)).length === 1, "second pass: the following action is replayed");

	// A broken rule (null condition) comes first: the following ones still apply.
	await db.delete(mailboxThreadLabels).where(eq(mailboxThreadLabels.labelId, label.id));
	await db.insert(mailRules).values({
		ownerId: f.user.id,
		workspaceId: f.workspace.id,
		identityId: f.identity.id,
		name: "broken",
		priority: 1,
		match: { version: 1, logic: "all", conditions: [null as any] },
	});
	threw = false;
	try {
		await processRules({ messageId: f.message.id });
	} catch {
		threw = true;
	}
	assert(!threw, "a broken rule does not make processRules throw");
	assert((await applied()).length === 1, "the label is set despite the broken rule that precedes it");

	// "Stop processing" holds even when an action of the rule throws: the following rule does not apply.
	// Throwing action: label identifier that is not a uuid.
	await db.delete(mailboxThreadLabels).where(eq(mailboxThreadLabels.labelId, label.id));
	const [stopRule] = await db
		.insert(mailRules)
		.values({
			ownerId: f.user.id,
			workspaceId: f.workspace.id,
			identityId: f.identity.id,
			name: "failing stop",
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
		params: { labelId: "not-a-uuid" },
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
	assert(!threw, "a stop rule whose action throws does not make processRules throw");
	assert(
		failures2.some((a) => String(a[0]).includes("Rule failed")),
		"the failure of the stop rule is logged",
	);
	assert((await applied()).length === 0, "the following rule does not apply after a failing stop rule");
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
