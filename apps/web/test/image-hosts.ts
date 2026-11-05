// /_next/image: allow-list of remote hosts. The proxy.ts matcher excludes _next/image from the session guard,
// so nothing protects this route besides remotePatterns: with hostname "**" any visitor could make the server
// download and re-serve any http(s) image (open proxy, SSRF on the internal network). The only uses of
// next/image (contact avatar, placehold.co fallback) are `unoptimized` and do not go through the optimizer;
// the list keeps only the avatar hosts of the code.
// Run from the repository root:
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
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const patterns = nextConfig.images?.remotePatterns ?? [];
const accepted = (url: string) => hasRemoteMatch([], patterns as any, new URL(url));

test("no generic hostname in remotePatterns", () => {
	for (const p of patterns as any[]) {
		assert.ok(p.hostname && !p.hostname.includes("*"), `generic hostname: ${p.hostname}`);
	}
});
test("https only", () => {
	for (const p of patterns as any[]) assert.equal(p.protocol, "https");
});
test("unknown host refused (/_next/image answers 400)", () => {
	assert.equal(accepted("https://evil.example.com/a.png"), false);
	assert.equal(accepted("http://evil.example.com/a.png"), false);
	assert.equal(accepted("http://169.254.169.254/latest/meta-data/"), false);
	assert.equal(accepted("http://localhost:3001/api/v1/anything"), false);
	assert.equal(accepted("https://placehold.co.evil.example.com/a.png"), false);
});
test("avatar hosts of the code accepted", () => {
	assert.equal(accepted("https://www.gravatar.com/avatar/abc?s=64&d=identicon"), true);
	assert.equal(accepted("https://placehold.co/512x512/png?text=Edit+Profile+Picture"), true);
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall tests pass");
