// Dependencies fixed for two CVEs: the fix lives in the resolved version, and a pnpm-lock.yaml taken from
// another branch or regenerated would bring the vulnerable ones back without any other test turning red.
// No database. Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/deps-cve.ts
// - mailparser CVE-2026-3455: textAsHtml (text/plain body) let a quote in a URL close the href attribute and
//   inject an attribute (onmouseover). Used by message-payload-parser.ts and packages/common/src/compose.ts.
// - drizzle-orm CVE-2026-39356: sql.identifier() did not escape the double quote, so an identifier name
//   controlled by a third party escaped its quotes (SQL injection).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let failures = 0;
const test = async (label: string, fn: () => void | Promise<void>) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

async function main() {
	await test("mailparser: a quote in a URL of the text does not leave the href attribute", async () => {
		const raw = [
			"From: a@example.org",
			"To: b@example.org",
			"Subject: test",
			"Content-Type: text/plain; charset=utf-8",
			"",
			'voir http://ex.fr/a"onmouseover="alert(1) fin',
		].join("\r\n");
		const parsed = await simpleParser(raw);
		const html = String(parsed.textAsHtml ?? "");
		assert.ok(html.includes("<a "), `link expected in ${html}`);
		// No onmouseover attribute may exist outside the quoted value of the href.
		assert.ok(!/<a [^>]*"\s*onmouseover=/.test(html), `injected attribute in ${html}`);
		assert.ok(!/<a [^>]*\sonmouseover=/.test(html), `injected attribute in ${html}`);
	});

	await test("drizzle-orm: sql.identifier doubles the double quote", () => {
		const q = new PgDialect().sqlToQuery(sql`select ${sql.identifier('x" from secrets --')} from t`);
		assert.equal(q.sql, 'select "x"" from secrets --" from t');
	});

	// mailparser 3.10+ is rewritten in TypeScript and ESM (2026-10-19): 3.9.47 is the last CJS
	// version, with the security fixes 3.9.3 to 3.9.40. No caret.
	await test("mailparser: version pinned to 3.9.47 in apps/worker/package.json", () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
		assert.equal(pkg.dependencies.mailparser, "3.9.47");
	});
}

main().then(() => {
	if (failures) {
		console.error(`\n${failures} failure(s)`);
		process.exit(1);
	}
	console.log("\nall ok");
});
