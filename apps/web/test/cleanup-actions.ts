// Nettoyage automatique depuis une recherche (MT8 de docs/plans/nettoyage-auto-recherche.md) : actions
// serveur du web. Une regle supprime des fils de facon permanente et repetee : seul le proprietaire de
// l'identite la cree, la suspend ou la supprime (meme famille que GHSA-cvh9-93mg-xvc9, commit 29091854,
// voir webhook-owner.ts), l'identite, le workspace et les dossiers sont relus en base (jamais pris de la
// saisie du navigateur), et le compte affiche avant confirmation vient du matcher que le tick utilise.
// Test de cablage sur le source (les actions lisent le cookie et la base). Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/cleanup-actions.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => (existsSync(join(ROOT, p)) ? strip(readFileSync(join(ROOT, p), "utf8")) : "");

const FILE = "apps/web/lib/actions/cleanup-rules.ts";
const src = read(FILE);
const body = (name: string, async = true) =>
	src.match(new RegExp(`${async ? "export " : ""}async function ${name}\\([\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";

const preview = body("previewCleanupRule");
const create = body("createCleanupRule");
const list = body("listCleanupRules");
const pause = body("setCleanupRulePaused");
const del = body("deleteCleanupRule");
const own = body("ownScope", false);

const OWNER = /identity\.ownerId\s*!==\s*user\.id|user\.id\s*!==\s*identity\.ownerId/;

test("fichier d'actions serveur, cinq actions", () => {
	assert.ok(src, `${FILE} absent`);
	assert.match(src.trimStart(), /^"use server";/);
	for (const [n, b] of Object.entries({ preview, create, list, pause, del })) assert.ok(b, `action ${n} absente`);
});

test("seules des fonctions async sont exportees (toute autre valeur casse un fichier use server)", () => {
	const exported = [...src.matchAll(/^export\s+(?!type\b|interface\b)(\w+(?:\s+\w+)?)/gm)].map((m) => m[1]);
	assert.ok(exported.length >= 5);
	for (const e of exported) assert.equal(e, "async function", `export non async : ${e}`);
	assert.deepEqual(
		[...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).sort(),
		["createCleanupRule", "deleteCleanupRule", "listCleanupRules", "previewCleanupRule", "setCleanupRulePaused"],
	);
});

test("ownScope : connecte, identite visible, proprietaire, avant tout acces aux donnees", () => {
	assert.ok(own, "helper ownScope absent");
	assert.match(own, /const user = await assertSignedIn\(\)/);
	assert.match(own, /await assertIdentityAccess\(\{ publicId:/);
	const guard = own.search(OWNER);
	assert.ok(guard > 0, "controle identity.ownerId !== user.id");
	assert.match(own, /propres bo[iî]tes/, "message propre a une identite visible mais d'un autre");
	assert.ok(own.indexOf("assertIdentityAccess") < guard);
	for (const access of ["rlsClient(", "resolveCleanupScope(", "from(mailboxes)", "matchCleanup(", "countStrictMatches(", "insertCleanupRule("]) {
		const at = own.indexOf(access);
		assert.ok(at < 0 || at > guard, `${access} avant le controle de propriete`);
	}
});

test("preview et creation passent par ownScope avant toute autre chose", () => {
	for (const [n, b] of Object.entries({ preview, create })) {
		const g = b.indexOf("ownScope(");
		assert.ok(g > 0, `${n} : ownScope`);
		for (const access of ["rlsClient(", "matchCleanup(", "countStrictMatches(", "insertCleanupRule(", "Typesense", "typesenseSearch("]) {
			const at = b.indexOf(access);
			assert.ok(at < 0 || at > g, `${n} : ${access} avant ownScope`);
		}
	}
});

test("scope : identite, workspace et dossiers relus en base, jamais pris du client", () => {
	const input = src.match(/export type CleanupRuleInput = \{[\s\S]*?\};/)?.[0] ?? "";
	assert.ok(input, "type d'entree");
	assert.deepEqual(
		[...input.matchAll(/(\w+)\??:/g)].map((m) => m[1]).sort(),
		["allFolders", "hasAttachment", "identityPublicId", "mailboxSlug", "onlyUnread", "query", "retentionDays"],
	);
	assert.match(own, /resolveCleanupScope\(/);
	assert.match(own, /from\(mailboxes\)[\s\S]*eq\(mailboxes\.identityId, identity\.id\)[\s\S]*eq\(mailboxes\.slug,/, "dossier relu par RLS depuis (identite, slug)");
	// Aucun champ de portee ne vient de la saisie : ni workspace, ni identifiants, ni dossiers.
	assert.doesNotMatch(src, /input\??\.(workspace\w*|identityId|mailboxId|mailboxIds|identityPublicId\w+)/);
	assert.doesNotMatch(src, /workspacePublicId\s*:/, "workspacePublicId construit a la main");
	assert.match(own, /\.\.\.target/, "scope = ce que la base a rendu, plus requete et filtres");
});

test("compte avant confirmation : countStrictMatches et matchCleanup de @common, pas la recherche affichee", () => {
	assert.match(src, /import \{[^}]*\bmatchCleanup\b[^}]*\} from "@common"/);
	assert.match(src, /import \{[^}]*\bcountStrictMatches\b[^}]*\} from "@common"/);
	assert.match(preview, /countStrictMatches\(\{ search \}, scope\)/);
	assert.match(preview, /matchCleanup\(\{ search, dbh \}, scope, \{[^}]*limit: CLEANUP_PREVIEW_CAP/);
	assert.match(preview, /matching/);
	assert.match(preview, /dueNow/);
	assert.match(preview, /truncated/);
	assert.match(preview, /new Set\(/, "fils distincts");
	assert.doesNotMatch(src, /initSearch|searchFilters|\.search\(\{[^}]*q:/);
	// matchCleanup n'a qu'une definition, celle que le tick utilisera.
	assert.match(read("packages/common/src/cleanup-match.ts"), /export async function matchCleanup\(/);
	assert.match(read("packages/common/src/index.ts"), /export \* from "\.\/cleanup-match"/);
	assert.doesNotMatch(src, /function matchCleanup|const matchCleanup/);
	// Le tick (MT6), quand il existe, appelle le meme matchCleanup.
	const tick = read("apps/worker/lib/mail-cleanup.ts");
	if (tick) assert.match(tick, /\bmatchCleanup\(/);
});

test("client Typesense construit comme select-all.ts, mesure strict de @common", () => {
	assert.match(src, /new Typesense\.Client\(/);
	assert.match(src, /getServerEnv\(\)/);
	assert.match(src, /collections\("messages"\)\.documents\(\)\.search\(/);
	assert.match(src, /from "typesense"/);
});

test("etoile : jamais un parametre ni un filtre", () => {
	assert.doesNotMatch(src, /starred/i);
});

test("creation : insertCleanupRule dans la transaction RLS, ownerId = utilisateur connecte, aucun job", () => {
	assert.match(create, /rls\(\(tx\) =>[\s\S]*insertCleanupRule\(tx, \{/);
	assert.match(create, /ownerId: user\.id/);
	assert.match(create, /identityId: scope\.identityId/);
	assert.match(create, /mailboxId/);
	assert.match(create, /if \(!res\.ok\)[\s\S]*res\.message/, "refus type de insertCleanupRule rendu tel quel");
	assert.doesNotMatch(src, /smtpQueue|\.add\(\s*"mail:|Queue\b/, "la creation ne poste aucun job : le tick suivant s'en charge");
});

test("liste : seulement les regles de l'utilisateur, de cette identite, sous RLS", () => {
	assert.match(list, /const user = await assertSignedIn\(\)/);
	assert.match(list, /await assertIdentityAccess\(\{ publicId:/);
	assert.match(list, /rls\(\(tx\) =>/);
	assert.match(list, /eq\(cleanupRules\.ownerId, user\.id\)/);
	assert.match(list, /eq\(cleanupRules\.identityId, identity\.id\)/);
	const guard = list.search(OWNER);
	assert.ok(guard > 0 && guard < list.indexOf("from(cleanupRules)"), "identite d'autrui : aucune requete");
	assert.match(list, /Tous les dossiers/);
	for (const f of ["retentionDays", "trashedCount", "lastTrashedAt", "paused"]) assert.match(list, new RegExp(f));
});

test("pause et suppression : identifiant valide, filtre ownerId en plus de RLS, regle introuvable = erreur", () => {
	for (const [n, b] of Object.entries({ pause, del })) {
		assert.match(b, /const user = await assertSignedIn\(\)/, `${n} : connecte`);
		assert.match(b, /isUuid\(/, `${n} : identifiant valide`);
		assert.match(b, /eq\(cleanupRules\.id, ruleId\)/);
		assert.match(b, /eq\(cleanupRules\.ownerId, user\.id\)/, `${n} : proprietaire`);
		assert.match(b, /rls\(\(tx\) =>/);
		assert.match(b, /\.returning\(/, `${n} : zero ligne detectee`);
		assert.match(b, /introuvable/i);
	}
	assert.match(pause, /\.update\(cleanupRules\)[\s\S]*paused: Boolean\(paused\)/);
	assert.match(del, /\.delete\(cleanupRules\)/);
});

test("toutes les actions rendent un FormState par handleAction", () => {
	for (const b of [preview, create, list, pause, del]) assert.match(b, /return handleAction\(/);
});

if (failed) {
	console.error(`${failed} test(s) en echec`);
	process.exit(1);
}
