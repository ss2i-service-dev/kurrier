// Environment of the mail MCP tests: a test Postgres database (db/init/migrations
// applied), no Redis, no S3. The variables required by getServerEnv() get dummy values.
// Run (from the repository root):
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/mcp-isolation.ts
const url = process.env.MCP_TEST_DATABASE_URL;
if (!url) {
	console.error("MCP_TEST_DATABASE_URL is required (a disposable Postgres with the migrations applied)");
	process.exit(2);
}
const defaults: Record<string, string> = {
	DATABASE_URL: url,
	DATABASE_RLS_URL: url,
	JWT_SECRET: "test-jwt-secret",
	APP_SECRET_ENCRYPTION_KEY: "test-app-secret-encryption-key",
	REDIS_PASSWORD: "x",
	REDIS_HOST: "127.0.0.1",
	REDIS_PORT: "1",
	TYPESENSE_API_KEY: "x",
	TYPESENSE_PORT: "1",
	TYPESENSE_PROTOCOL: "http",
	TYPESENSE_HOST: "127.0.0.1",
	SEARCH_REBUILD_ON_BOOT: "false",
	S3_REGION: "garage",
	S3_BUCKET: "kurrier-test",
	S3_ENDPOINT: "http://127.0.0.1:1",
	S3_ACCESS_KEY: "x",
	S3_SECRET_KEY: "x",
	S3_FORCE_PATH_STYLE: "true",
	WEB_URL: "https://mail.test.invalid",
	// MCP origin distinct from the webmail, as in production (separate port).
	MCP_PUBLIC_ORIGIN: "https://mail.test.invalid:8443",
	DAV_URL: "http://127.0.0.1:1",
	NODE_ENV: "test",
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;

export const assert = (cond: unknown, label: string) => {
	if (!cond) {
		console.error(`FAIL  ${label}`);
		process.exitCode = 1;
		return false;
	}
	console.log(`ok    ${label}`);
	return true;
};

export const expectThrow = async (fn: () => Promise<unknown>, pattern: RegExp, label: string) => {
	try {
		await fn();
		return assert(false, `${label} (no error thrown)`);
	} catch (err: any) {
		const msg = String(err?.message ?? err);
		return assert(pattern.test(msg), `${label} -> ${msg}`);
	}
};

// Fake h3 event: just what lib/mcp/auth.ts reads (headers, path, response).
export const fakeEvent = (headers: Record<string, string> = {}, path = "/api/kurrier/mcp") => {
	const resHeaders: Record<string, string> = {};
	return {
		path,
		node: {
			req: { headers, url: path, method: "POST" },
			res: {
				setHeader: (k: string, v: string) => {
					resHeaders[k.toLowerCase()] = v;
				},
				getHeader: (k: string) => resHeaders[k.toLowerCase()],
				statusCode: 200,
			},
		},
		_resHeaders: resHeaders,
	} as any;
};
