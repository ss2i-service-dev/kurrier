// meta des lignes inserees sans meta (18/11 : 188 messages envoyes, 2 781 contacts, 15 providers a
// meta = jsonb 'null', pas le NULL SQL). La cause est le DEFAULT 'null'::jsonb des colonnes meta
// (migration 002) : toute insertion qui omet meta, comme la copie Envoyes de send-mail.ts
// (MessageInsertSchema.parse sans metaData), recevait le JSON null, que `meta || objet` et
// jsonb_set ne savent pas fusionner (job mail:move 8355). Verifie : aucune colonne meta n'a ce
// DEFAULT (migration ss2i_010), et une copie Envoyes inseree comme send-mail.ts a un meta NULL.
// Base de test : voir mcp-test-env.ts :
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
	assert(defaults.length === 0, `aucune colonne meta n'a le DEFAULT 'null'::jsonb (${defaults.map((r) => r.table_name).join(", ")})`);

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
		subject: "copie envoyes",
		text: "corps",
		html: "<p>corps</p>",
		ownerId: f.user.id,
		seen: true,
	});
	const [m] = await db.insert(messages).values(parsed as MessageCreate).returning({ id: messages.id });
	const [r] = (await db.execute(sql`select meta is null as sql_null, jsonb_typeof(meta) as t from messages where id = ${m.id}::uuid`)) as unknown as Array<{ sql_null: boolean; t: string | null }>;
	assert(r.sql_null === true, `copie Envoyes inseree comme send-mail.ts : meta est un NULL SQL (type ${r.t})`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
