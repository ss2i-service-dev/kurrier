// A tab stays on the old version after a redeploy: Next no longer finds the Server Action of the
// old bundle ("An unexpected response was received from the server."). Option "Reload the page
// after an update" (prefAutoReloadOnUpdate, off by default): build number, version route in
// no-store, and, when the option is on, a stale tab is never left usable: a veil blocks the page
// and reloads it, once per version (drafts have their local copy). Run (from the root):
//   node_modules/.bin/tsx apps/web/test/app-version.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBuildVersion, isFailedActionCall, isStaleActionResponse, onNewVersion, takeReloadSlot } from "../lib/app-version";
import { forceReload, getStale, isWatching, setWatching } from "../lib/stale-tab";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const web = join(__dirname, "..");
const source = (path: string) => readFileSync(join(web, path), "utf8");

test("build number: UTC date and time", () => {
	assert.equal(formatBuildVersion(new Date("2026-11-10T07:42:00Z")), "20261110.0742");
	assert.equal(formatBuildVersion(new Date("2026-07-01T22:05:00Z")), "20260701.2205");
	assert.equal(formatBuildVersion(new Date("2026-01-02T00:00:00Z")), "20260102.0000");
});

test("same version: nothing", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "a", reloadedFor: null }), "none");
});

test("unknown served version (route down, server restarting): nothing", () => {
	assert.equal(onNewVersion({ loaded: "a", served: null, reloadedFor: null }), "none");
	assert.equal(onNewVersion({ loaded: "a", served: "", reloadedFor: null }), "none");
});

test("new version: forced reload, even while a mail is being written", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: null }), "reload");
});

test("already reloaded for this version and still the old bundle: page blocked, no loop", () => {
	assert.equal(onNewVersion({ loaded: "a", served: "b", reloadedFor: "b" }), "block");
});

test("unknown Server Action (x-nextjs-action-not-found header): stale tab", () => {
	assert.equal(isStaleActionResponse(new Headers({ "x-nextjs-action-not-found": "1" })), true);
	assert.equal(isStaleActionResponse(new Headers({ "content-type": "text/x-component" })), false);
	assert.equal(isStaleActionResponse(null), false);
});

test("failed Server Action call: immediate check of the version", () => {
	assert.equal(isFailedActionCall({ "Next-Action": "abc" }, { ok: false, status: 409 }), true);
	assert.equal(isFailedActionCall(new Headers({ "next-action": "abc" }), { ok: false, status: 404 }), true);
	assert.equal(isFailedActionCall([["next-action", "abc"]], { ok: false, status: 500 }), true);
	assert.equal(isFailedActionCall({ "Next-Action": "abc" }, { ok: true, status: 200 }), false);
	assert.equal(isFailedActionCall({ Accept: "text/html" }, { ok: false, status: 500 }), false);
	assert.equal(isFailedActionCall(undefined, { ok: false, status: 500 }), false);
});

// An unknown or failed Server Action reloads without any version to compare (served equals
// loaded, e.g. old and new instances mixed during a rolling deploy): without a bound, each
// failure after a reload would reload again.
test("two failures in a row: a single automatic reload per 5 minutes, whatever the cause", () => {
	const data = new Map<string, string>();
	const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
	const t0 = Date.parse("2026-11-23T08:00:00Z");
	assert.equal(takeReloadSlot(store, t0), true, "first failure: reload");
	assert.equal(takeReloadSlot(store, t0 + 2_000), false, "second failure after the reload: veil only");
	assert.equal(takeReloadSlot(store, t0 + 299_000), false, "still inside the 5 minutes");
	assert.equal(takeReloadSlot(store, t0 + 300_000), true, "5 minutes later: allowed again");
	assert.equal(takeReloadSlot(store, t0 + 301_000), false);
});

test("reload slot: no usable storage means no automatic reload (never a loop)", () => {
	const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
	assert.equal(takeReloadSlot(broken, 1_000_000), false);
	assert.equal(takeReloadSlot(null, 1_000_000), false);
	assert.match(source("components/common/version-watcher.tsx"), /takeReloadSlot\(/);
});

test("stale state: reload wins over a block, set once", () => {
	assert.equal(getStale(), null);
	forceReload("b", false);
	assert.deepEqual(getStale(), { served: "b", autoReload: false });
	forceReload(null, true);
	assert.deepEqual(getStale(), { served: null, autoReload: true });
	forceReload("c", false);
	assert.deepEqual(getStale(), { served: null, autoReload: true });
});

test("watching flag: off until the watcher mounts", () => {
	assert.equal(isWatching(), false);
	setWatching(true);
	assert.equal(isWatching(), true);
	setWatching(false);
});

test("version route exists, in no-store, and the build number is injected by next.config.ts", () => {
	const route = join(web, "app/api/version/route.ts");
	assert.ok(existsSync(route), "app/api/version/route.ts");
	assert.match(readFileSync(route, "utf8"), /no-store/);
	const config = source("next.config.ts");
	assert.match(config, /env: \{ NEXT_PUBLIC_BUILD_VERSION: buildVersion \}/);
	assert.match(config, /process\.env\.NEXT_PUBLIC_BUILD_VERSION \|\|= /, "written back: child processes inherit one value");
});

test("watcher: blocking veil and reload, no \"offer to reload\" toast, failed action calls checked", () => {
	const watcher = source("components/common/version-watcher.tsx");
	assert.doesNotMatch(watcher, /contenteditable/);
	assert.doesNotMatch(watcher, /toast\(/);
	assert.match(watcher, /isStaleActionResponse\(/);
	assert.match(watcher, /isFailedActionCall\(/);
	assert.match(watcher, /role="alertdialog"/);
});

test("new mail pulse: leaves the stale tab to the watcher when it runs, keeps its notice otherwise", () => {
	const notifier = source("components/k/new-mail-notifier.tsx");
	assert.match(notifier, /if \(staleShown \|\| isWatching\(\)\) return;/);
	assert.match(notifier, /A new version of Kurrier is available/);
});

test("option off by default: the watcher is mounted only when the user turned it on", () => {
	const layout = source("app/layout.tsx");
	assert.match(layout, /autoReloadEnabled\(\)/);
	assert.match(layout, /\{autoReload && <VersionWatcher \/>\}/);
	assert.ok(!/<VersionWatcher \/>/.test(layout.replace("{autoReload && <VersionWatcher />}", "")), "no other mount");
	const action = source("lib/actions/auto-reload.ts");
	assert.match(action, /prefAutoReloadOnUpdate/);
	assert.match(action, /::boolean, false\)`/, "coalesce to false");
});

test("settings: a switch, off by default, saves through setAutoReloadEnabled", () => {
	const panel = source("components/mailbox/settings/settings-unread-panel.tsx");
	assert.match(panel, /autoReload: initialAutoReload = false/);
	assert.match(panel, /setAutoReloadEnabled\(next\)/);
	assert.match(panel, /label=\{"Reload the page after an update"\}/);
	assert.match(source("app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/settings/page.tsx"), /autoReload=\{autoReload\}/);
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\napp-version: all tests pass");
