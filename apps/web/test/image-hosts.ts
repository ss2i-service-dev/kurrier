// /_next/image : liste blanche des hotes distants (OI 10343). Le matcher de proxy.ts exclut
// _next/image du garde de session, donc rien ne protege cette route hors de remotePatterns :
// avec hostname "**" tout visiteur pouvait faire telecharger et re-servir par le serveur
// n'importe quelle image http(s) (proxy ouvert, SSRF sur le reseau interne). Les seuls
// usages de next/image (avatar de contact, fallback placehold.co) sont `unoptimized` et ne
// passent pas par l'optimiseur ; la liste ne garde que les hotes d'avatars du code.
// Lance depuis la racine :
//   node_modules/.bin/tsx apps/web/test/image-hosts.ts
import assert from "node:assert/strict";
import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import nextConfig from "../next.config";

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

const patterns = nextConfig.images?.remotePatterns ?? [];
const accepted = (url: string) => hasRemoteMatch([], patterns as any, new URL(url));

test("aucun hostname generique dans remotePatterns", () => {
	for (const p of patterns as any[]) {
		assert.ok(p.hostname && !p.hostname.includes("*"), `hostname generique : ${p.hostname}`);
	}
});
test("https seulement", () => {
	for (const p of patterns as any[]) assert.equal(p.protocol, "https");
});
test("hote inconnu refuse (/_next/image repond 400)", () => {
	assert.equal(accepted("https://evil.example.com/a.png"), false);
	assert.equal(accepted("http://evil.example.com/a.png"), false);
	assert.equal(accepted("http://169.254.169.254/latest/meta-data/"), false);
	assert.equal(accepted("http://localhost:3001/api/v1/anything"), false);
	assert.equal(accepted("https://placehold.co.evil.example.com/a.png"), false);
});
test("hotes d'avatars du code acceptes", () => {
	assert.equal(accepted("https://www.gravatar.com/avatar/abc?s=64&d=identicon"), true);
	assert.equal(accepted("https://placehold.co/512x512/png?text=Edit+Profile+Picture"), true);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
