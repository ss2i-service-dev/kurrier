// Test utility: creates a test user and issues it an OAuth token, then prints the token
// (for an HTTP trial of the built worker, see mcp-test-env.ts).
import crypto from "node:crypto";
import "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { exchangeAuthorizationCode, issueAuthorizationCode, registerClient, resolveClient } from "../../web/lib/mcp-oauth";

async function main() {
	const u = await createUserFixture("smoke");
	const client = await registerClient({ client_name: "smoke", redirect_uris: ["http://localhost/cb"] });
	const resolved = (await resolveClient(client.client_id))!;
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	const code = await issueAuthorizationCode({ client: resolved, userId: u.user.id, redirectUri: "http://localhost/cb", codeChallenge: challenge });
	const tokens = await exchangeAuthorizationCode({ code, code_verifier: verifier, client_id: client.client_id, redirect_uri: "http://localhost/cb" });
	console.log(JSON.stringify({ email: u.email, thread_id: u.thread.id, access_token: tokens.access_token }));
	process.exit(0);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
