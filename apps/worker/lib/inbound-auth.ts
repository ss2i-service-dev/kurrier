import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { db, identities, providers } from "@db";
import { and, eq } from "drizzle-orm";
import {
	createError,
	getQuery,
	getRequestHeader,
	H3Event,
	readBody,
	readMultipartFormData,
	readRawBody,
} from "h3";

// Access control for the providers' inbound webhooks (routes api/v1/hooks/*). The
// sender's From address and the authentication headers (SPF, DKIM, DMARC) are not enough
// proof by themselves. Each route requires the proof specific to its provider; if the
// secret is not configured, the request is refused (403), never accepted by default.
//
// Variables (worker):
//   MAILGUN_WEBHOOK_SIGNING_KEY  Mailgun "HTTP webhook signing key" (HMAC-SHA256
//                                of timestamp + token, signature field);
//   POSTMARK_INBOUND_TOKEN       shared secret: Basic password of the webhook URL
//                                (https://user:<secret>@...) or ?token=<secret> parameter
//                                (Postmark does not sign its inbound webhooks);
//   SENDGRID_INBOUND_PUBLIC_KEY  base64 ECDSA public key of the Inbound Parse security
//                                policy (X-Twilio-Email-Event-Webhook-* headers);
//   SES_INBOUND_TOPIC_ARNS       ARNs of the accepted SNS topics (comma-separated),
//                                SNS signature verified in addition.

export const forbidden = (why: string) => {
	console.warn(`[inbound-hook] refused: ${why}`);
	return createError({ statusCode: 403, statusMessage: "Forbidden" });
};

const safeEqual = (a: string, b: string) => {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// Fields of an inbound form, multipart or urlencoded (Mailgun sends either).
export async function readFormFields(event: H3Event): Promise<Record<string, string>> {
	const type = String(getRequestHeader(event, "content-type") ?? "");
	if (type.startsWith("multipart/form-data")) {
		const parts = (await readMultipartFormData(event)) ?? [];
		const out: Record<string, string> = {};
		for (const p of parts) if (p.name && !p.filename) out[p.name] = p.data.toString("utf8");
		return out;
	}
	const body = await readBody(event);
	return body && typeof body === "object" ? (body as Record<string, string>) : {};
}

export function verifyMailgun(fields: Record<string, unknown>) {
	const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
	if (!key) throw forbidden("mailgun: MAILGUN_WEBHOOK_SIGNING_KEY not configured");
	const timestamp = String(fields.timestamp ?? "");
	const token = String(fields.token ?? "");
	const signature = String(fields.signature ?? "");
	if (!timestamp || !token || !signature) throw forbidden("mailgun: missing signature fields");
	const expected = createHmac("sha256", key).update(timestamp + token).digest("hex");
	if (!safeEqual(expected, signature.toLowerCase())) throw forbidden("mailgun: bad signature");
}

export function verifyPostmark(event: H3Event) {
	const secret = process.env.POSTMARK_INBOUND_TOKEN;
	if (!secret) throw forbidden("postmark: POSTMARK_INBOUND_TOKEN not configured");
	const auth = String(getRequestHeader(event, "authorization") ?? "");
	if (auth.startsWith("Basic ")) {
		const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
		const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : "";
		if (password && safeEqual(password, secret)) return;
	}
	const token = String(getQuery(event)?.token ?? "");
	if (token && safeEqual(token, secret)) return;
	throw forbidden("postmark: missing or bad credentials");
}

// Same scheme as SendGrid's signed Event Webhook: ECDSA (P-256, SHA-256) over
// timestamp + raw body, public key in base64 (DER SPKI), signature in base64 (DER).
export async function verifySendgrid(event: H3Event) {
	const publicKey = process.env.SENDGRID_INBOUND_PUBLIC_KEY;
	if (!publicKey) throw forbidden("sendgrid: SENDGRID_INBOUND_PUBLIC_KEY not configured");
	const signature = String(getRequestHeader(event, "x-twilio-email-event-webhook-signature") ?? "");
	const timestamp = String(getRequestHeader(event, "x-twilio-email-event-webhook-timestamp") ?? "");
	if (!signature || !timestamp) throw forbidden("sendgrid: missing signature headers");
	const raw = (await readRawBody(event, false)) ?? Buffer.alloc(0);
	let ok = false;
	try {
		const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
		ok = cryptoVerify(
			"sha256",
			Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(raw)]),
			key,
			Buffer.from(signature, "base64"),
		);
	} catch {
		ok = false;
	}
	if (!ok) throw forbidden("sendgrid: bad signature");
}

// Amazon SNS: allowed topic, certificate URL on AWS, message signature
// (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const certCache = new Map<string, string>();

const snsHostOk = (url: unknown) => {
	try {
		const u = new URL(String(url ?? ""));
		return u.protocol === "https:" && SNS_HOST.test(u.hostname);
	} catch {
		return false;
	}
};

export function snsStringToSign(msg: Record<string, any>) {
	const keys =
		msg.Type === "Notification"
			? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
			: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
	return keys
		.filter((k) => !(k === "Subject" && (msg.Subject === undefined || msg.Subject === null)))
		.map((k) => `${k}\n${msg[k]}\n`)
		.join("");
}

export async function verifySns(msg: Record<string, any>) {
	const topics = String(process.env.SES_INBOUND_TOPIC_ARNS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	if (!topics.length) throw forbidden("ses: SES_INBOUND_TOPIC_ARNS not configured");
	if (!msg || typeof msg !== "object") throw forbidden("ses: bad payload");
	if (!topics.includes(String(msg.TopicArn ?? ""))) throw forbidden("ses: topic not allowed");
	if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(msg.Type)) {
		throw forbidden("ses: bad message type");
	}
	if (!snsHostOk(msg.SigningCertURL) || !String(msg.SigningCertURL).endsWith(".pem")) {
		throw forbidden("ses: bad certificate URL");
	}
	if (msg.SubscribeURL !== undefined && !snsHostOk(msg.SubscribeURL)) {
		throw forbidden("ses: bad subscribe URL");
	}
	const algorithm = msg.SignatureVersion === "2" ? "sha256" : msg.SignatureVersion === "1" ? "sha1" : null;
	if (!algorithm || !msg.Signature) throw forbidden("ses: bad signature version");

	let cert = certCache.get(msg.SigningCertURL);
	if (!cert) {
		const res = await fetch(msg.SigningCertURL);
		if (!res.ok) throw forbidden("ses: certificate not available");
		cert = await res.text();
		certCache.set(msg.SigningCertURL, cert);
	}
	let ok = false;
	try {
		ok = cryptoVerify(
			algorithm,
			Buffer.from(snsStringToSign(msg), "utf8"),
			cert,
			Buffer.from(String(msg.Signature), "base64"),
		);
	} catch {
		ok = false;
	}
	if (!ok) throw forbidden("ses: bad signature");
}

// Recipient identity of a verified inbound webhook. The signature proves the message comes
// from the configured provider account, not which workspace it is meant for: the address
// alone is not enough (the same address can exist in two workspaces). The identity must
// therefore use a provider of this type, and be the only one; otherwise the message is refused.
export async function inboundIdentityFor(
	address: string | null,
	providerType: "mailgun" | "postmark" | "sendgrid",
) {
	if (!address) return null;
	const rows = await db
		.select({ identity: identities })
		.from(identities)
		.innerJoin(providers, eq(identities.providerId, providers.id))
		.where(and(eq(identities.value, address), eq(providers.type, providerType)))
		.limit(2);
	if (rows.length > 1) {
		console.warn(`[inbound-hook] ${providerType}: ${address} matches several identities: refused`);
		return null;
	}
	return rows[0]?.identity ?? null;
}
