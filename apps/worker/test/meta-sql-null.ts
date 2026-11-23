// meta of rows inserted without meta: jsonb 'null', not the SQL NULL. The cause is the DEFAULT
// 'null'::jsonb of the meta columns (migration 002): any insert that omits meta, like the Sent
// copy of send-mail.ts (MessageInsertSchema.parse without metaData), received the JSON null,
// which `meta || object` and jsonb_set cannot merge (mail:move job failing). Checks: no meta
// column has that DEFAULT (migration community_007), and a Sent copy inserted like send-mail.ts
// has a NULL meta.
// Test database: see mcp-test-env.ts:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55437/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/meta-sql-null.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, MessageInsertSchema, messages, threads, type MessageCreate } from "@db";
import { sql } from "drizzle-orm";

async function main() {
	const defaults = (await db.execute(sql`
		select table_name from information_schema.columns
		where table_schema = 'public' and column_name = 'meta' and column_default like '%null%jsonb%'
		order by 1
	`)) as unknown as Array<{ table_name: string }>;
	assert(defaults.length === 0, `no meta column has the DEFAULT 'null'::jsonb (${defaults.map((r) => r.table_name).join(", ")})`);

	const f = await createUserFixture("meta-sql-null");
	const [t] = await db.insert(threads).values({ ownerId: f.user.id, workspaceId: f.workspace.id, lastMessageDate: new Date() }).returning();
	const parsed = MessageInsertSchema.parse({
		mailboxId: f.sent.id,
		workspaceId: f.workspace.id,
		threadId: t.id,
		messageId: `<meta-sql-null-${Date.now()}@x>`,
		references: [],
		hasAttachments: false,
		to: { to: [], cc: [], bcc: [], from: [] },
		from: f.identity.value,
		cc: { to: [], cc: [], bcc: [], from: [] },
		bcc: { to: [], cc: [], bcc: [], from: [] },
		snippet: "",
		subject: "sent copy",
		text: "body",
		html: "<p>body</p>",
		ownerId: f.user.id,
		seen: true,
	});
	const [m] = await db.insert(messages).values(parsed as MessageCreate).returning({ id: messages.id });
	const [r] = (await db.execute(sql`select meta is null as sql_null, jsonb_typeof(meta) as t from messages where id = ${m.id}::uuid`)) as unknown as Array<{ sql_null: boolean; t: string | null }>;
	assert(r.sql_null === true, `Sent copy inserted like send-mail.ts: meta is a SQL NULL (type ${r.t})`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
