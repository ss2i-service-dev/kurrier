// Nettoyage automatique depuis une recherche (MT1 de docs/plans/nettoyage-auto-recherche.md) : partie
// pure de la requete stricte (validation du texte cherche, cutoff, duree libre, parametres Typesense).
// Aucune base, aucun reseau. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/cleanup-rules.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLEANUP_MAX_DAYS,
	CLEANUP_QUERY_BY,
	type CleanupScope,
	cleanupCutoff,
	cleanupDaysFromFree,
	cleanupQueryError,
	cleanupSearchParams,
} from "../../../packages/common/src/cleanup-rules";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}\n${(e as Error).stack}`);
	}
}

const ROOT = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MB1 = "11111111-1111-4111-8111-111111111111";
const MB2 = "22222222-2222-4222-8222-222222222222";
const SCOPE: CleanupScope = {
	identityId: "99999999-9999-4999-8999-999999999999",
	identityPublicId: "idpub",
	workspacePublicId: "wspub",
	mailboxIds: [MB1],
	query: "relevé de compte",
	hasAttachment: false,
	onlyUnread: false,
	retentionDays: 30,
};
const NOW = new Date("2026-11-25T08:00:00Z");

test("cleanupQueryError : refuse vide, court, joker, exclusions seules, tokens trop courts", () => {
	for (const q of ["", "   ", "ab", " ab ", "*", " * ", "-banque", "- - -", "a b c", "-a -b -c", '-"relevé de compte"', '-"relevé compte', '-"relevé compte"']) {
		const e = cleanupQueryError(q);
		assert.equal(typeof e, "string", `"${q}" doit etre refusee`);
		assert.ok(e!.length > 0);
	}
});

test("cleanupQueryError : refuse plus de 200 caracteres apres trim, accepte exactement 200", () => {
	assert.equal(typeof cleanupQueryError("a".repeat(201)), "string");
	assert.equal(typeof cleanupQueryError(` ${"a".repeat(201)} `), "string");
	assert.equal(cleanupQueryError("a".repeat(200)), null);
	assert.equal(cleanupQueryError(` ${"a".repeat(200)} `), null);
});

test("cleanupQueryError : accepte une requete avec un token positif de 3 caracteres", () => {
	for (const q of ["relevé de compte", "news@liste.org", "tdsynnex.com -promo", "abc", "-promo banque", "123", '"relevé de compte"', 'banque -"offre spéciale"', 'banque -"offre']) {
		assert.equal(cleanupQueryError(q), null, `"${q}" doit etre acceptee`);
	}
});

test("cleanupQueryError : trois lettres consecutives dans un meme token, pas reparties", () => {
	assert.equal(typeof cleanupQueryError("a-b-c d.e"), "string");
	assert.equal(cleanupQueryError("a.b relevé"), null);
});

test("cleanupCutoff : now moins N jours de 86 400 000 ms", () => {
	assert.equal(cleanupCutoff(NOW, 30).getTime(), NOW.getTime() - 30 * 86_400_000);
	assert.equal(cleanupCutoff(NOW, 1).toISOString(), "2026-11-24T08:00:00.000Z");
	assert.equal(cleanupCutoff(NOW, 7).toISOString(), "2026-11-18T08:00:00.000Z");
});

test("cleanupDaysFromFree : jour 1, semaine 7, mois 30, an 365", () => {
	assert.equal(cleanupDaysFromFree(1, "day"), 1);
	assert.equal(cleanupDaysFromFree(3, "day"), 3);
	assert.equal(cleanupDaysFromFree(2, "week"), 14);
	assert.equal(cleanupDaysFromFree(2, "month"), 60);
	assert.equal(cleanupDaysFromFree(1, "year"), 365);
});

test("cleanupDaysFromFree : NaN rend null (l'appelant refuse), Infinity est borne au maximum", () => {
	assert.equal(cleanupDaysFromFree(Number.NaN, "day"), null);
	assert.equal(cleanupDaysFromFree(Number.NaN, "year"), null);
	assert.equal(cleanupDaysFromFree(Number.POSITIVE_INFINITY, "day"), CLEANUP_MAX_DAYS);
	assert.equal(cleanupDaysFromFree(Number.NEGATIVE_INFINITY, "day"), 1);
});

test("cleanupDaysFromFree : borne a 1..3650 jours", () => {
	assert.equal(cleanupDaysFromFree(0, "day"), 1);
	assert.equal(cleanupDaysFromFree(-5, "month"), 1);
	assert.equal(cleanupDaysFromFree(0.4, "day"), 1);
	assert.equal(cleanupDaysFromFree(100, "year"), CLEANUP_MAX_DAYS);
	assert.equal(cleanupDaysFromFree(3650, "day"), 3650);
	assert.equal(cleanupDaysFromFree(3651, "day"), 3650);
});

test("cleanupSearchParams : les six parametres stricts et le reste a la valeur exacte", () => {
	const cutoff = cleanupCutoff(NOW, 30);
	const p = cleanupSearchParams(SCOPE, { cutoff, page: 3 });
	assert.ok(p);
	assert.equal(p!.q, "relevé de compte");
	assert.equal(p!.query_by, "subject,snippet,fromName,fromEmail,fromDomain,participants");
	assert.equal(p!.num_typos, 0);
	assert.equal(p!.prefix, false);
	assert.equal(p!.drop_tokens_threshold, 0);
	assert.equal(p!.typo_tokens_threshold, 0);
	assert.equal(p!.split_join_tokens, "off");
	assert.ok(!("exhaustive_search" in p!), "exhaustive_search annule drop_tokens_threshold 0 (Typesense 29) : requete en OU");
	assert.equal(p!.sort_by, "createdAt:asc");
	assert.equal(p!.group_by, "threadId");
	assert.equal(p!.group_limit, 1);
	assert.equal(p!.per_page, 250);
	assert.equal(p!.page, 3);
	assert.equal(p!.include_fields, "id,threadId,mailboxId");
});

test("cleanupSearchParams : filter_by sur workspace, identite, dossiers et cutoff en millisecondes", () => {
	const cutoff = cleanupCutoff(NOW, 30);
	const p = cleanupSearchParams({ ...SCOPE, mailboxIds: [MB1, MB2] }, { cutoff, page: 1 });
	assert.equal(
		p!.filter_by,
		`workspacePublicId:="wspub" && identityPublicId:="idpub" && mailboxId:=[\`${MB1}\`,\`${MB2}\`] && createdAt:<=${cutoff.getTime()}`,
	);
	assert.match(String(cutoff.getTime()), /^\d{13}$/, "createdAt de l'index est en millisecondes");
});

test("cleanupSearchParams : sans cutoff, pas de filtre d'age ; filtres piece jointe et non lu selon le scope", () => {
	const p = cleanupSearchParams({ ...SCOPE, hasAttachment: true, onlyUnread: true }, { page: 1 });
	assert.ok(!p!.filter_by.includes("createdAt"));
	assert.ok(p!.filter_by.endsWith("&& hasAttachment:=1 && unread:=1"), p!.filter_by);
	const q = cleanupSearchParams(SCOPE, { cutoff: null, page: 1 });
	assert.ok(!q!.filter_by.includes("hasAttachment") && !q!.filter_by.includes("unread"));
	assert.ok(!q!.filter_by.includes("createdAt"));
});

test("cleanupSearchParams : workspace et identite passent par JSON.stringify", () => {
	const p = cleanupSearchParams({ ...SCOPE, identityPublicId: 'a"b' }, { page: 1 });
	assert.ok(p!.filter_by.includes(`identityPublicId:=${JSON.stringify('a"b')}`));
});

test("cleanupSearchParams : un identifiant de dossier qui n'est pas un UUID rend null", () => {
	for (const bad of ["inbox", `${MB1}\`,\`x`, "", `${MB1}]`, "11111111-1111-1111-1111-11111111111"]) {
		assert.equal(cleanupSearchParams({ ...SCOPE, mailboxIds: [MB1, bad] }, { page: 1 }), null, `"${bad}"`);
	}
});

test("cleanupSearchParams : liste de dossiers vide rend null", () => {
	assert.equal(cleanupSearchParams({ ...SCOPE, mailboxIds: [] }, { page: 1 }), null);
});

test("cleanupSearchParams : aucun parametre n'expose l'etoile", () => {
	const p = cleanupSearchParams(SCOPE, { cutoff: cleanupCutoff(NOW, 30), page: 1 });
	assert.ok(!/starred/.test(JSON.stringify(p)));
});

test("query_by identique a celui de la recherche du webmail (actions/mailbox.ts)", () => {
	const mailbox = src("apps/web/lib/actions/mailbox.ts");
	assert.ok(mailbox.includes(`query_by: "${CLEANUP_QUERY_BY}",`), "query_by de mailbox.ts different de CLEANUP_QUERY_BY");
});

test("index de @common : cleanup-rules exporte", () => {
	assert.match(src("packages/common/src/index.ts"), /export \* from "\.\/cleanup-rules";/);
});

if (failed) {
	console.error(`\n${failed} test(s) en echec`);
	process.exit(1);
}
console.log("\ncleanup-rules : tout est vert");
