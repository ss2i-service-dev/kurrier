// Nettoyage automatique (docs/plans/nettoyage-auto-recherche.md, MT7) : branchement du tick dans le
// common-worker, verifie sur le source : le case mail:cleanup-tick appelle runCleanupTick avec la file
// du smtp-worker et le client Typesense, le scheduler tourne toutes les 15 min comme mail:expire-tick,
// qui reste inchange. Aucune base.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/cleanup-wiring.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const src = readFileSync(join(__dirname, "../server/plugins/common-worker.ts"), "utf8");

// Corps du case `name` : de `case "name": {` au `case` ou `default` suivant.
function caseBody(name: string): string {
	const start = src.indexOf(`case "${name}": {`);
	assert.ok(start >= 0, `case ${name} absent`);
	const rest = src.slice(start + 1);
	const next = rest.search(/\n\t\t\t\t(case "|default:)/);
	return next < 0 ? rest : rest.slice(0, next);
}

// Appel upsertJobScheduler dont l'id est `id`, jusqu'au `);` de fin.
function schedulerCall(id: string): string {
	const start = src.indexOf(`"${id}"`);
	assert.ok(start >= 0, `scheduler ${id} absent`);
	const end = src.indexOf("\n\t);", start);
	return src.slice(start, end);
}

test("le case mail:cleanup-tick existe et appelle runCleanupTick", () => {
	const body = caseBody("mail:cleanup-tick");
	assert.match(body, /runCleanupTick\(/);
	assert.match(src, /import \{ runCleanupTick \} from "\.\.\/\.\.\/lib\/mail-cleanup"/);
});

test("enqueue = smtpQueue.add, now = new Date()", () => {
	const body = caseBody("mail:cleanup-tick");
	assert.match(body, /const \{ smtpQueue \} = await getRedis\(\)/);
	assert.match(body, /now: new Date\(\)/);
	assert.match(body, /enqueue: \(name, data, opts\) => smtpQueue\.add\(name, data, opts\)/);
});

test("search = collection messages du client get-typesense", () => {
	const body = caseBody("mail:cleanup-tick");
	assert.match(src, /import typesense from "\.\.\/\.\.\/lib\/get-typesense"/);
	assert.match(body, /search: \(p\) => typesense\.collections\("messages"\)\.documents\(\)\.search\(p\)/);
});

test("le case rend { success: true, ...res }", () => {
	assert.match(caseBody("mail:cleanup-tick"), /return \{ success: true, \.\.\.res \}/);
});

test("cleanup-tick-scheduler : mail:cleanup-tick toutes les 15 min, attempts 1", () => {
	const call = schedulerCall("cleanup-tick-scheduler");
	assert.match(call, /every: 15 \* 60 \* 1000/);
	assert.match(call, /"mail:cleanup-tick"/);
	assert.match(call, /attempts: 1/);
	assert.match(call, /removeOnComplete: true/);
	assert.match(call, /removeOnFail: false/);
	assert.match(call, /override: true/);
});

test("mail:expire-tick inchange (case et scheduler)", () => {
	const body = caseBody("mail:expire-tick");
	assert.match(body, /runExpiryTick\(/);
	assert.match(body, /enqueue: \(name, data, opts\) => smtpQueue\.add\(name, data, opts\)/);
	assert.doesNotMatch(body, /runCleanupTick/);
	const call = schedulerCall("expire-tick-scheduler");
	assert.match(call, /every: 15 \* 60 \* 1000/);
	assert.match(call, /"mail:expire-tick"/);
	assert.match(call, /attempts: 1/);
});

if (failures) {
	console.error(`${failures} echec(s)`);
	process.exit(1);
}
console.log("tout passe");
