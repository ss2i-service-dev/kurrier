// Envoi refuse par le serveur SMTP : le fournisseur doit rendre la cause, et le worker doit
// traiter tout { success: false } comme un echec, cause connue ou non. Avant : smtp.ts rendait
// { success: false } sans `error`, send-mail.ts ne testait que `mailerResponse.error` et rendait
// success:true -> brouillon supprime, aucune copie dans Sent, aucune erreur affichee.
// Boite d'envoi (OI 10519) : Message-ID fixe par courrier avant le SMTP, reponse du serveur
// gardee, et `ambiguous` quand l'issue est inconnue (coupure apres DATA sans reponse chiffree) :
// le mail est peut-etre parti, jamais de renvoi sans confirmation.
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

// Serveur SMTP local scriptable : accepte enveloppe et contenu, puis repond `afterData` a la fin
// du contenu (null : coupe la connexion sans repondre, comme un relais qui tombe apres DATA).
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

await test("fournisseur SMTP : le Message-ID fixe par courrier part tel quel, la reponse 250 est gardee", async () => {
	const srv = await scriptedServer("250 2.0.0 Ok: queued as ABC123");
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], {
			...message,
			messageId: "<fixe-1@example.com>",
		});
		assert.equal(res.success, true);
		assert.equal(res.MessageId, "<fixe-1@example.com>");
		assert.match(String(res.response), /queued as ABC123/);
		assert.match(srv.received[0] ?? "", /^Message-ID: <fixe-1@example\.com>/im);
	} finally {
		srv.close();
	}
});

await test("fournisseur SMTP : un refus chiffre (554) n'est pas ambigu", async () => {
	const srv = await refusingServer();
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], message);
		assert.equal(res.success, false);
		assert.equal(res.ambiguous, false);
	} finally {
		srv.close();
	}
});

await test("fournisseur SMTP : un refus chiffre apres DATA n'est pas ambigu", async () => {
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

await test("fournisseur SMTP : connexion refusee, rien n'est parti (pas ambigu)", async () => {
	const srv = await scriptedServer("250 ok");
	const port = srv.port;
	srv.close();
	await new Promise((r) => setTimeout(r, 50));
	const res: any = await mailerOn(port).sendEmail(["dest@example.com"], message);
	assert.equal(res.success, false);
	assert.equal(res.ambiguous, false);
});

await test("fournisseur SMTP : coupure apres le contenu sans reponse = issue inconnue (ambigu)", async () => {
	const srv = await scriptedServer(null);
	try {
		const res: any = await mailerOn(srv.port).sendEmail(["dest@example.com"], message);
		assert.equal(res.success, false);
		assert.equal(res.ambiguous, true);
		assert.equal(srv.received.length, 1, "le contenu est bien arrive au serveur");
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
