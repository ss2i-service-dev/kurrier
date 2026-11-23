// Send refused by the SMTP server: the provider must return the cause, and the worker must
// treat any { success: false } as a failure, cause known or not. Before: smtp.ts returned
// { success: false } without `error`, send-mail.ts only tested `mailerResponse.error` and returned
// success:true -> draft deleted, no copy in Sent, no error shown.
// Outbox: Message-ID set before SMTP, server reply kept, and `ambiguous` when the outcome is
// unknown (connection cut after DATA without a numeric reply): the mail may have been sent,
// never resent without confirmation.
// Run (from the root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/send-refused.ts
import assert from "node:assert/strict";
import net from "node:net";
import { SMTP_TIMEOUTS, SmtpMailer } from "../../../packages/providers/src/mail/smtp";
import { mailerFailureOf } from "../lib/send-outcome";
import { STALE_SENDING_MS } from "../lib/send/pipeline";

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

// Scriptable local SMTP server: accepts envelope and content, then replies `afterData` at the end
// of the content (null: cuts the connection without replying, like a relay that drops after DATA).
const scriptedServer = (afterData: string | null) =>
	new Promise<{ port: number; close: () => void; received: string[] }>((resolve) => {
		const received: string[] = [];
		const srv = net.createServer((sock) => {
			let inData = false;
			let buf = "";
			sock.write("220 test ESMTP\r\n");
			sock.on("data", (chunk) => {
				buf += chunk.toString();
				for (;;) {
					if (inData) {
						const end = buf.indexOf("\r\n.\r\n");
						if (end < 0) return;
						received.push(buf.slice(0, end));
						buf = buf.slice(end + 5);
						inData = false;
						if (afterData === null) return void sock.destroy();
						sock.write(`${afterData}\r\n`);
						continue;
					}
					const nl = buf.indexOf("\r\n");
					if (nl < 0) return;
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 2);
					if (/^(EHLO|HELO)/i.test(line)) sock.write("250 test\r\n");
					else if (/^DATA/i.test(line)) {
						inData = true;
						sock.write("354 go\r\n");
					} else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
					else sock.write("250 ok\r\n");
				}
			});
		});
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			resolve({ port, close: () => srv.close(), received });
		});
	});

const mailerOn = (port: number) =>
	SmtpMailer.from({
		SMTP_HOST: "127.0.0.1",
		SMTP_PORT: String(port),
		SMTP_SECURE: "false",
		SMTP_USERNAME: "u",
		SMTP_PASSWORD: "p",
	});

const message = { from: "moi@example.com", subject: "test", text: "corps" } as any;

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

await test("SMTP provider: the Message-ID set before sending leaves as is, the 250 reply is kept", async () => {
	const srv = await scriptedServer("250 2.0.0 Ok: queued as ABC123");
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], {
			...message,
			messageId: "<fixed-1@example.com>",
		});
		assert.equal(res.success, true);
		assert.equal(res.MessageId, "<fixed-1@example.com>");
		assert.match(String(res.response), /queued as ABC123/);
		assert.match(srv.received[0] ?? "", /^Message-ID: <fixed-1@example\.com>/im);
	} finally {
		srv.close();
	}
});

await test("SMTP provider: a numeric refusal (554) is not ambiguous", async () => {
	const srv = await refusingServer();
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], message);
		assert.equal(res.success, false);
		assert.equal(res.ambiguous, false);
	} finally {
		srv.close();
	}
});

await test("SMTP provider: a numeric refusal after DATA is not ambiguous", async () => {
	const srv = await scriptedServer("550 5.7.1 Message rejected");
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], message);
		assert.equal(res.success, false);
		assert.equal(res.ambiguous, false);
		assert.match(String(res.error), /550/);
	} finally {
		srv.close();
	}
});

await test("SMTP provider: connection refused, nothing left (not ambiguous)", async () => {
	const srv = await scriptedServer("250 ok");
	const port = srv.port;
	srv.close();
	await new Promise((r) => setTimeout(r, 50));
	const res: any = await mailerOn(port).sendEmail(["dest@example.com"], message);
	assert.equal(res.success, false);
	assert.equal(res.ambiguous, false);
});

await test("SMTP provider: cut after the content without a reply = unknown outcome (ambiguous)", async () => {
	const srv = await scriptedServer(null);
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], message);
		assert.equal(res.success, false);
		assert.equal(res.ambiguous, true);
		assert.equal(srv.received.length, 1, "the content did reach the server");
	} finally {
		srv.close();
	}
});

await test("SMTP provider: transport timeouts well below the sweep's \"interrupted\" threshold", () => {
	const opts = (mailerOn(25) as any).transporter.options;
	for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout"] as const) {
		assert.equal(opts[k], SMTP_TIMEOUTS[k], k);
		assert.ok(opts[k] > 0 && opts[k] <= STALE_SENDING_MS / 4, `${k} = ${opts[k]} ms`);
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
