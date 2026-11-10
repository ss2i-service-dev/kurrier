// An unknown root file is a real 404 rendered by the proxy (/docker-compose.yaml and /..%2F.env
// used to render the 404 page with a 200 status).
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/root-file-not-found.ts
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isUnknownRootFile, PUBLIC_ROOT_FILES } from "../lib/root-file-not-found";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL ${label}\n      ${err?.message ?? err}`);
	}
};

test("attack paths at the root: 404", () => {
	for (const p of ["/docker-compose.yaml", "/.env", "/..%2F.env", "/api%2F.env", "/api%2F..%2F.env", "/oauth%2F.env", "/secrets.env",
		"/.git/config", "/wp-config.php", "/robots.txt", "/backup.tar.gz"]) {
		assert.equal(isUnknownRootFile(p), true, p);
	}
});

test("pages, API and public files: left to their own route", () => {
	for (const p of ["/", "/en", "/en/auth/login", "/ko/w/abc/dashboard", "/en/docker-compose.yaml",
		"/api/auth/resume", "/api/attachments/x.png", "/oauth/token", "/.well-known/oauth-authorization-server",
		"/_next/static/chunks/a.js", "/keyboard-shortcuts.js", "/nimportequoi"]) {
		assert.equal(isUnknownRootFile(p), false, p);
	}
});

test("PUBLIC_ROOT_FILES covers all of public/ except images and favicon (excluded from the matcher)", () => {
	const dir = join(__dirname, "..", "public");
	const servis = readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => "/" + join(d.parentPath ?? (d as any).path, d.name).slice(dir.length + 1))
		.filter((p) => !/\.(svg|png|jpe?g|gif|webp)$/i.test(p) && p !== "/favicon.ico");
	for (const p of servis) {
		assert.equal(isUnknownRootFile(p), false, `${p} missing from PUBLIC_ROOT_FILES`);
	}
	assert.ok(PUBLIC_ROOT_FILES.size >= 1);
});

if (failures) {
	console.log(`\n${failures} failing test(s)`);
	process.exit(1);
}
console.log("\nall tests pass");
