// Envoi refuse par le serveur SMTP : le fournisseur doit rendre la cause, et le worker doit
// traiter tout { success: false } comme un echec, cause connue ou non. Avant : smtp.ts rendait
// { success: false } sans `error`, send-mail.ts ne testait que `mailerResponse.error` et rendait
// success:true -> brouillon supprime, aucune copie dans Sent, aucune erreur affichee.
// Lancement (depuis la racine) :
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

// Serveur SMTP local qui accepte la connexion puis refuse le message (comme Stalwart ou le
// relais Graph qui repond 554).
const refusingServer = () =>
	new Promise<{ port: number; close: () => void }>((resolve) => {
		const srv = net.createServer((sock) => {
			sock.write("220 test ESMTP\r\n");
			sock.on("data", (buf) => {
				const line = buf.toString();
				if (/^(EHLO|HELO)/i.test(line)) sock.write("250 test\r\n");
				else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
				else sock.write("554 5.0.0 Refus de Graph (400)\r\n");
			});
		});
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			resolve({ port, close: () => srv.close() });
		});
	});

(async () => {
await test("fournisseur SMTP : un refus du serveur rend success:false avec la cause", async () => {
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
			from: "moi@example.com",
			subject: "test",
			text: "corps",
		} as any);
		assert.equal(res.success, false);
		assert.ok(res.error, "error doit porter la cause");
		assert.match(String(res.error), /554|Refus/);
	} finally {
		srv.close();
	}
});

await test("worker : success:false sans cause est un echec", () => {
	const err = mailerFailureOf({ success: false });
	assert.ok(err, "un refus sans cause doit rester un echec");
});

await test("worker : success:false avec cause garde la cause", () => {
	assert.match(String(mailerFailureOf({ success: false, error: "554 refus" })), /554 refus/);
});

await test("worker : success:true n'est pas un echec", () => {
	assert.equal(mailerFailureOf({ success: true, MessageId: "<x@y>" }), null);
});

if (failures) {
	console.error(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
})();
