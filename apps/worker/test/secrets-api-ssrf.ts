// Second batch of access-control checks: secrets decrypted per owner (decryptAdminSecrets),
// API keys (validateApiKeyToken), private addresses refused (@common/safe-http). Test
// database as in mcp-isolation.ts (see mcp-test-env.ts):
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/secrets-api-ssrf.ts
import { assert, expectThrow } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import {
	apiKeys,
	createSecretAdmin,
	db,
	decryptAdminSecrets,
	smtpAccounts,
	smtpAccountSecrets,
} from "@db";
import { validateApiKeyToken } from "../lib/api-helpers";
import { assertPublicUrl, isPrivateIp, publicHttpRequest, publicLookup } from "@common/safe-http";

async function main() {
	const a = await createUserFixture("sec-a");
	const b = await createUserFixture("sec-b");

	console.log("# decryptAdminSecrets");
	const [account] = await db
		.insert(smtpAccounts)
		.values({ ownerId: a.user.id, workspaceId: a.workspace.id })
		.returning();
	const secret = await createSecretAdmin({
		ownerId: a.user.id,
		workspaceId: a.workspace.id,
		name: `smtp-${Date.now()}`,
		value: JSON.stringify({ SMTP_PASSWORD: "pw-a" }),
	});
	await db.insert(smtpAccountSecrets).values({ accountId: account.id, secretId: secret.id, workspaceId: a.workspace.id } as any);
	const args = {
		linkTable: smtpAccountSecrets,
		foreignCol: smtpAccountSecrets.accountId,
		secretIdCol: smtpAccountSecrets.secretId,
		parentId: account.id,
	};
	const own = await decryptAdminSecrets({ ...args, ownerId: a.user.id });
	assert(own.length === 1 && own[0].vault.decrypted_secret.includes("pw-a"), "owner gets the secret of its account");
	const other = await decryptAdminSecrets({ ...args, ownerId: b.user.id });
	assert(other.length === 0, "another owner gets nothing for the same account");

	console.log("# validateApiKeyToken");
	const rawKey = `pfx${Date.now() % 1000}.${"k".repeat(28)}abcd`;
	const [prefix] = rawKey.split(".");
	const keySecret = await createSecretAdmin({
		ownerId: a.user.id,
		workspaceId: a.workspace.id,
		name: `api-${Date.now()}`,
		value: JSON.stringify({ rawKey }),
	});
	await db.insert(apiKeys).values({
		ownerId: a.user.id,
		workspaceId: a.workspace.id,
		name: "test",
		secretId: keySecret.id,
		keyPrefix: prefix,
		keyLast4: rawKey.slice(-4),
		scopes: ["emails:send"],
	} as any);
	const ok = await validateApiKeyToken(rawKey).catch((e) => e);
	assert(ok?.ownerId === a.user.id && ok?.secret === rawKey, "valid API key accepted");
	await expectThrow(
		() => validateApiKeyToken(`${prefix}.${"x".repeat(28)}abcd`),
		/Invalid API key/,
		"wrong key with same prefix and last4 refused",
	);

	console.log("# safe-http");
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
		assert(isPrivateIp(ip), `${ip} is private`);
	}
	for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
		assert(!isPrivateIp(ip), `${ip} is public`);
	}
	await expectThrow(() => assertPublicUrl("http://127.0.0.1:6379/", { allowHttp: true }), /private/, "loopback IP refused");
	await expectThrow(() => assertPublicUrl("http://localhost/", { allowHttp: true }), /private/, "localhost refused (DNS)");
	await expectThrow(() => assertPublicUrl("http://[::1]/", { allowHttp: true }), /private/, "IPv6 loopback refused");
	await expectThrow(() => assertPublicUrl("http://example.com/"), /not https/, "http refused when https required");
	await expectThrow(() => assertPublicUrl("ftp://example.com/", { allowHttp: true }), /http or https/, "other scheme refused");
	await expectThrow(
		() => publicHttpRequest("http://169.254.169.254/latest/meta-data/", { method: "GET", allowHttp: true }),
		/private/,
		"request to metadata IP refused",
	);
	const lookupError = await new Promise<string>((resolve) =>
		publicLookup("localhost", {}, (err: any) => resolve(String(err?.message ?? "no error"))),
	);
	assert(/private/.test(lookupError), `connection-time lookup refuses localhost -> ${lookupError}`);

	console.log(process.exitCode ? "\nFAILURES" : "\nALL OK");
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
