// A webhook can only be added to an identity you own (upstream advisory GHSA-cvh9-93mg-xvc9).
// addWebhook accepted any identity visible under RLS (domain identity, shared with the
// workspace, or one you are a member of): a colleague could receive every incoming message of a
// shared mailbox at an external URL, even after the sharing ended. The worker now only fires the
// webhooks of the identity owner (apps/worker/test/webhook-owner.ts); here, the creation is
// refused.
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

test("addWebhook: action found", () => {
	assert.ok(addWebhook.includes("insert(webhooks)"), "body of addWebhook");
});

test("addWebhook: the identity must belong to the signed-in user", () => {
	assert.match(addWebhook, /const user = await (assertSignedIn|isSignedIn)\(\)/);
	assert.match(addWebhook, /identity\.ownerId\s*!==\s*user\.id|user\.id\s*!==\s*identity\.ownerId/);
});

test("addWebhook: checked before the insert, refusal distinct from the missing identity", () => {
	const check = addWebhook.search(/identity\.ownerId\s*!==\s*user\.id|user\.id\s*!==\s*identity\.ownerId/);
	assert.ok(check > 0 && check < addWebhook.indexOf("insert(webhooks)"), "check before insert(webhooks)");
	assert.match(addWebhook, /Choose an identity for this webhook\./);
	assert.match(addWebhook, /error: "[^"]*own[^"]*"/i, "message for an identity that is visible but someone else's");
});

// No other way to write a webhook from the interface (no update action).
function walk(dir: string, out: string[] = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".next" || name === "test") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(ts|tsx)$/.test(name)) out.push(p);
	}
	return out;
}

test("interface: addWebhook is the only creation, no webhook update", () => {
	const writers = walk(WEB).flatMap((f) => {
		const src = strip(readFileSync(f, "utf8"));
		return [...src.matchAll(/\.(insert|update)\(webhooks\)/g)].map((m) => `${f.slice(WEB.length + 1)}:${m[1]}`);
	});
	assert.deepEqual(writers, ["lib/actions/dashboard.ts:insert"]);
});

if (failed) {
	console.error(`${failed} test(s) failed`);
	process.exit(1);
}
