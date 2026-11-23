// Send refused by the SMTP server: the provider must return the cause, and the worker must
// treat any { success: false } as a failure, cause known or not. Before: smtp.ts returned
// { success: false } without `error`, send-mail.ts only tested `mailerResponse.error` and returned
// success:true -> draft deleted, no copy in Sent, no error shown.
// Run (from the root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/send-refused.ts
import assert from "node:assert/strict";
import net from "node:net";
import { SmtpMailer } from "../../../packages/providers/src/mail/smtp";
import { mailerFailureOf } from "../lib/send-outcome";

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

// Local SMTP server that accepts the connection then refuses the message (like a relay that
// answers 554).
const refusingServer = () =>
	new Promise<{ port: number; close: () => void }>((resolve) => {
		const srv = net.createServer((sock) => {
			sock.write("220 test ESMTP\r\n");
			sock.on("data", (buf) => {
				const line = buf.toString();
				if (/^(EHLO|HELO)/i.test(line)) sock.write("250 test\r\n");
				else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
				else sock.write("554 5.0.0 Message refused by the relay\r\n");
			});
		});
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			resolve({ port, close: () => srv.close() });
		});
	});

(async () => {
await test("SMTP provider: a server refusal returns success:false with the cause", async () => {
	const srv = await refusingServer();
	try {
		const mailer = SmtpMailer.from({
			SMTP_HOST: "127.0.0.1",
			SMTP_PORT: String(srv.port),
			SMTP_SECURE: "false",
			SMTP_USERNAME: "u",
			SMTP_PASSWORD: "p",
		});
		const res: { success: boolean; error?: string } = await mailer.sendEmail(["dest@example.com"], {
			from: "me@example.com",
			subject: "test",
			text: "body",
		} as any);
		assert.equal(res.success, false);
		assert.ok(res.error, "error must carry the cause");
		assert.match(String(res.error), /554|refused/);
	} finally {
		srv.close();
	}
});

await test("worker: success:false without a cause is a failure", () => {
	const err = mailerFailureOf({ success: false });
	assert.ok(err, "a refusal without a cause must stay a failure");
});

await test("worker: success:false with a cause keeps the cause", () => {
	assert.match(String(mailerFailureOf({ success: false, error: "554 refused" })), /554 refused/);
});

await test("worker: success:true is not a failure", () => {
	assert.equal(mailerFailureOf({ success: true, MessageId: "<x@y>" }), null);
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
})();
