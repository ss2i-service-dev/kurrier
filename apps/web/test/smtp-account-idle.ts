// Saving an SMTP/IMAP account (corrected password) queues an imap:start-idle for each identity that uses it:
// without it, the IMAP suspension for refused credentials (6 h) survived the password change. From the root:
//   node_modules/.bin/tsx apps/web/test/smtp-account-idle.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restartIdleForSmtpAccount } from "../lib/smtp-account-idle";

let failures = 0;
const test = (label: string, fn: () => Promise<void> | void) =>
	Promise.resolve()
		.then(fn)
		.then(() => console.log(`ok    ${label}`))
		.catch((err: any) => {
			failures++;
			console.log(`FAIL ${label}\n      ${err?.message ?? err}`);
		});

async function main() {
	await test("one imap:start-idle per identity of the modified account", async () => {
		const queued: string[] = [];
		const asked: string[] = [];
		const out = await restartIdleForSmtpAccount("acc-1", {
			identityIdsOf: async (id) => (asked.push(id), ["i1", "i2"]),
			enqueueStartIdle: async (id) => void queued.push(id),
		});
		assert.deepEqual(asked, ["acc-1"]);
		assert.deepEqual(queued, ["i1", "i2"]);
		assert.deepEqual(out, ["i1", "i2"]);
	});
	await test("account without identity: no job", async () => {
		const queued: string[] = [];
		await restartIdleForSmtpAccount("acc-2", {
			identityIdsOf: async () => [],
			enqueueStartIdle: async (id) => void queued.push(id),
		});
		assert.deepEqual(queued, []);
	});
	await test("a job that fails to queue stops neither the others nor the saving", async () => {
		const queued: string[] = [];
		const origError = console.error;
		console.error = () => {};
		let out: string[];
		try {
			out = await restartIdleForSmtpAccount("acc-3", {
				identityIdsOf: async () => ["i1", "i2", "i3"],
				enqueueStartIdle: async (id) => {
					if (id === "i2") throw new Error("redis down");
					queued.push(id);
				},
			});
		} finally {
			console.error = origError;
		}
		assert.deepEqual(queued, ["i1", "i3"]);
		assert.deepEqual(out, ["i1", "i3"]);
	});

	const src = readFileSync(join(__dirname, "../lib/actions/dashboard.ts"), "utf8");
	const start = src.indexOf("export async function upsertSMTPAccount");
	const body = src.slice(start, src.indexOf("\nexport ", start + 10));
	await test("upsertSMTPAccount wiring: restart after the secret update, on the modified account", () => {
		assert.ok(start > 0, "upsertSMTPAccount not found");
		assert.match(body, /restartIdleForSmtpAccount\(String\(parsed\.accountId\)/);
		assert.match(body, /enqueueStartIdle: restartImapIdle/);
		assert.match(body, /eq\(identities\.smtpAccountId, accountId\)/);
		assert.ok(
			body.indexOf("updateSecret(") < body.indexOf("restartIdleForSmtpAccount("),
			"the restart must follow the saving of the secret",
		);
		const branch = body.slice(body.indexOf("if (parsed.accountId)"), body.indexOf("} else {\n\t\t\tconst secretMeta"));
		assert.ok(branch.includes("restartIdleForSmtpAccount("), "the restart must be in the update branch");
	});
	const jobs = readFileSync(join(__dirname, "../lib/mail-jobs.ts"), "utf8");
	await test("restartImapIdle queues imap:start-idle on the smtp-worker queue", () => {
		assert.match(jobs, /export const restartImapIdle = async \(identityId: string\)/);
		const fn = jobs.slice(jobs.indexOf("export const restartImapIdle"));
		assert.match(fn, /smtpQueue\.add\(\s*"imap:start-idle",\s*\{ identityId \}/);
	});

	if (failures) {
		console.log(`\n${failures} failure(s)`);
		process.exit(1);
	}
	console.log("\nall green");
}
main();
