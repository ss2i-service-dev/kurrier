// Un webhook ne se pose que sur une identite dont on est proprietaire (releve au tri de l'amont
// v4.4.1, GHSA-cvh9-93mg-xvc9, commit 0a6cbc5). addWebhook acceptait toute identite visible
// sous RLS (identite de domaine, partagee avec le workspace, ou dont on est membre) : un
// collegue pouvait recevoir chaque message entrant d'une boite partagee a une URL externe,
// meme apres la fin du partage. Le worker ne declenche plus que les webhooks du proprietaire
// de l'identite (apps/worker/test/webhook-owner.ts) ; ici, la creation est refusee.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

const WEB = join(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (p: string) => strip(readFileSync(join(WEB, p), "utf8"));

const dashboard = code("lib/actions/dashboard.ts");
const addWebhook = dashboard.match(/export async function addWebhook\([\s\S]*?\n\}\n/)?.[0] ?? "";

test("addWebhook : action trouvee", () => {
	assert.ok(addWebhook.includes("insert(webhooks)"), "corps d'addWebhook");
});

test("addWebhook : l'identite doit appartenir a l'utilisateur connecte", () => {
	assert.match(addWebhook, /const user = await (assertSignedIn|isSignedIn)\(\)/);
	assert.match(addWebhook, /identity\.ownerId\s*!==\s*user\.id|user\.id\s*!==\s*identity\.ownerId/);
});

test("addWebhook : controle avant l'insertion, refus distinct de l'identite manquante", () => {
	const check = addWebhook.search(/identity\.ownerId\s*!==\s*user\.id|user\.id\s*!==\s*identity\.ownerId/);
	assert.ok(check > 0 && check < addWebhook.indexOf("insert(webhooks)"), "controle avant insert(webhooks)");
	assert.match(addWebhook, /Choose an identity for this webhook\./);
	assert.match(addWebhook, /error: "[^"]*own[^"]*"/i, "message propre a une identite visible mais d'un autre");
});

// Aucun autre chemin d'ecriture d'un webhook cote interface (pas d'action de mise a jour).
function walk(dir: string, out: string[] = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".next" || name === "test") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(ts|tsx)$/.test(name)) out.push(p);
	}
	return out;
}

test("interface : addWebhook est la seule creation, aucune mise a jour de webhook", () => {
	const writers = walk(WEB).flatMap((f) => {
		const src = strip(readFileSync(f, "utf8"));
		return [...src.matchAll(/\.(insert|update)\(webhooks\)/g)].map((m) => `${f.slice(WEB.length + 1)}:${m[1]}`);
	});
	assert.deepEqual(writers, ["lib/actions/dashboard.ts:insert"]);
});

if (failed) {
	console.error(`${failed} test(s) en echec`);
	process.exit(1);
}
