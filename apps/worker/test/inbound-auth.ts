// Inbound webhooks (lib/inbound-auth.ts): refusal without a configured secret, refusal of
// a wrong signature, acceptance of a good one. No database query and no network request,
// but the module loads @db: variables from mcp-test-env.ts, like the other tests:
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/inbound-auth.ts
import "./mcp-test-env";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { snsStringToSign, verifyMailgun, verifyPostmark, verifySendgrid, verifySns } from "../lib/inbound-auth";

let failed = false;
const assert = (cond: unknown, label: string) => {
	console.log(`${cond ? "ok  " : "FAIL"}  ${label}`);
	if (!cond) failed = true;
};
const refused = async (fn: () => unknown, label: string) => {
	try {
		await fn();
		assert(false, `${label} (accepted)`);
	} catch (err: any) {
		assert(err?.statusCode === 403, `${label} -> ${err?.statusCode}`);
	}
};
const accepted = async (fn: () => unknown, label: string) => {
	try {
		await fn();
		assert(true, label);
	} catch (err: any) {
		assert(false, `${label} -> ${err?.statusCode ?? err?.message}`);
	}
};

// Fake h3 event: headers, URL and raw body (read by readRawBody).
const fakeEvent = (headers: Record<string, string>, body = "", url = "/api/v1/hooks/x") =>
	({
		method: "POST",
		path: url,
		node: { req: { headers, url, method: "POST", body: Buffer.from(body) }, res: {} },
	}) as any;

async function main() {
	console.log("# mailgun");
	delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
	const fields = { timestamp: "1700000000", token: "abc", signature: "00" };
	await refused(() => verifyMailgun(fields), "no signing key configured");
	process.env.MAILGUN_WEBHOOK_SIGNING_KEY = "key-test";
	await refused(() => verifyMailgun(fields), "bad signature");
	await refused(() => verifyMailgun({}), "missing fields");
	const good = createHmac("sha256", "key-test").update("1700000000abc").digest("hex");
	await accepted(() => verifyMailgun({ ...fields, signature: good }), "good signature");

	console.log("# postmark");
	delete process.env.POSTMARK_INBOUND_TOKEN;
	await refused(() => verifyPostmark(fakeEvent({})), "no token configured");
	process.env.POSTMARK_INBOUND_TOKEN = "s3cret";
	await refused(() => verifyPostmark(fakeEvent({})), "no credentials");
	const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
	await refused(() => verifyPostmark(fakeEvent({ authorization: basic("pm", "wrong") })), "wrong password");
	await accepted(() => verifyPostmark(fakeEvent({ authorization: basic("pm", "s3cret") })), "basic auth");
	await accepted(() => verifyPostmark(fakeEvent({}, "", "/api/v1/hooks/postmark/inbound?token=s3cret")), "token query");

	console.log("# sendgrid");
	delete process.env.SENDGRID_INBOUND_PUBLIC_KEY;
	await refused(() => verifySendgrid(fakeEvent({}, "x")), "no public key configured");
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	process.env.SENDGRID_INBOUND_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");
	const body = "--b\r\nContent-Disposition: form-data; name=\"email\"\r\n\r\nraw\r\n--b--\r\n";
	const ts = "1700000000";
	const sig = sign("sha256", Buffer.from(ts + body), privateKey).toString("base64");
	const headers = (s: string) => ({
		"x-twilio-email-event-webhook-signature": s,
		"x-twilio-email-event-webhook-timestamp": ts,
		"content-type": "multipart/form-data; boundary=b",
	});
	await refused(() => verifySendgrid(fakeEvent(headers(sig), body + "tampered")), "tampered body");
	await refused(() => verifySendgrid(fakeEvent({}, body)), "missing headers");
	await accepted(() => verifySendgrid(fakeEvent(headers(sig), body)), "good signature");

	console.log("# ses (sns)");
	delete process.env.SES_INBOUND_TOPIC_ARNS;
	const msg = {
		Type: "Notification",
		MessageId: "m1",
		TopicArn: "arn:aws:sns:eu-west-1:123:inbound",
		Message: "{}",
		Timestamp: "2026-11-04T00:00:00.000Z",
		SignatureVersion: "1",
		Signature: "AA==",
		SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-x.pem",
	};
	await refused(() => verifySns(msg), "no topic configured");
	process.env.SES_INBOUND_TOPIC_ARNS = "arn:aws:sns:eu-west-1:123:other";
	await refused(() => verifySns(msg), "topic not allowed");
	process.env.SES_INBOUND_TOPIC_ARNS = msg.TopicArn;
	await refused(() => verifySns({ ...msg, SigningCertURL: "https://evil.example/cert.pem" }), "certificate outside AWS");
	await refused(
		() => verifySns({ ...msg, Type: "SubscriptionConfirmation", SubscribeURL: "http://169.254.169.254/" }),
		"subscribe URL outside AWS",
	);
	// Signature verified end to end: the certificate (here a PEM public key, which
	// crypto.verify treats as a certificate) is served by a mocked fetch.
	const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = rsa.publicKey.export({ format: "pem", type: "spki" }).toString();
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(pem)) as any;
	const signed = { ...msg, SignatureVersion: "2", SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-good.pem" };
	signed.Signature = sign("sha256", Buffer.from(snsStringToSign(signed)), rsa.privateKey).toString("base64");
	await accepted(() => verifySns(signed), "good SNS signature (v2)");
	await refused(() => verifySns({ ...signed, Message: "{\"forged\":1}" }), "forged SNS message");
	globalThis.fetch = realFetch;
	assert(
		snsStringToSign(msg) ===
			"Message\n{}\nMessageId\nm1\nTimestamp\n2026-11-04T00:00:00.000Z\nTopicArn\narn:aws:sns:eu-west-1:123:inbound\nType\nNotification\n",
		"string to sign (notification without subject)",
	);

	console.log(failed ? "\nFAILURES" : "\nALL OK");
	process.exit(failed ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
