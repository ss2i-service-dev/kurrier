// Dependances corrigees pour deux CVE (OI 10345) : le correctif tient a la version resolue, un
// pnpm-lock.yaml repris d'une autre branche ou regenere les ramenerait sans qu'aucun autre test
// ne rougisse. Aucune base. Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/deps-cve.ts
// - mailparser CVE-2026-3455 : textAsHtml (corps text/plain) laissait un guillemet d'une URL
//   fermer l'attribut href et injecter un attribut (onmouseover). Consomme par
//   message-payload-parser.ts et packages/common/src/compose.ts.
// - drizzle-orm CVE-2026-39356 : sql.identifier() n'echappait pas le guillemet double, un nom
//   d'identifiant controle par un tiers sortait de ses guillemets (injection SQL).
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
	await test("mailparser : un guillemet dans une URL du texte ne sort pas de l'attribut href", async () => {
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
		assert.ok(html.includes("<a "), `lien attendu dans ${html}`);
		// Aucun attribut onmouseover ne doit exister en dehors de la valeur entre guillemets du href.
		assert.ok(!/<a [^>]*"\s*onmouseover=/.test(html), `attribut injecte dans ${html}`);
		assert.ok(!/<a [^>]*\sonmouseover=/.test(html), `attribut injecte dans ${html}`);
	});

	await test("drizzle-orm : sql.identifier double le guillemet double", () => {
		const q = new PgDialect().sqlToQuery(sql`select ${sql.identifier('x" from secrets --')} from t`);
		assert.equal(q.sql, 'select "x"" from secrets --" from t');
	});

	// mailparser 3.10+ est reecrit en TypeScript et en ESM (19/10/2026) : 3.9.47 est la derniere
	// version CJS, avec les correctifs de securite 3.9.3 a 3.9.40. Pas de caret.
	await test("mailparser : version epinglee a 3.9.47 dans apps/worker/package.json", () => {
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
