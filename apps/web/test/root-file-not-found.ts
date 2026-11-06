// Fichier racine inconnu = vrai 404 rendu par le proxy (rapport CrowdSec du 06/11/2026 :
// /docker-compose.yaml et /..%2F.env rendaient la page 404 avec le statut 200).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/root-file-not-found.ts
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
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

test("chemins d'attaque a la racine : 404", () => {
	for (const p of ["/docker-compose.yaml", "/.env", "/..%2F.env", "/api%2F.env", "/api%2F..%2F.env", "/oauth%2F.env", "/secrets.env",
		"/.git/config", "/wp-config.php", "/robots.txt", "/backup.tar.gz"]) {
		assert.equal(isUnknownRootFile(p), true, p);
	}
});

test("pages, API et fichiers publics : laisses a leur route", () => {
	for (const p of ["/", "/en", "/en/auth/login", "/ko/w/abc/dashboard", "/en/docker-compose.yaml",
		"/api/auth/resume", "/api/attachments/x.png", "/oauth/token", "/.well-known/oauth-authorization-server",
		"/_next/static/chunks/a.js", "/ss2i-shortcuts.js", "/nimportequoi"]) {
		assert.equal(isUnknownRootFile(p), false, p);
	}
});

test("PUBLIC_ROOT_FILES couvre tout public/ hors images et favicon (exclus du matcher)", () => {
	const dir = join(__dirname, "..", "public");
	const servis = readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => "/" + join(d.parentPath ?? (d as any).path, d.name).slice(dir.length + 1))
		.filter((p) => !/\.(svg|png|jpe?g|gif|webp)$/i.test(p) && p !== "/favicon.ico");
	for (const p of servis) {
		assert.equal(isUnknownRootFile(p), false, `${p} absent de PUBLIC_ROOT_FILES`);
	}
	assert.ok(PUBLIC_ROOT_FILES.size >= 1);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\ntous les tests passent");
