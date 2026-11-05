import { defineEventHandler, readMultipartFormData } from "h3";
import { db, mailboxes } from "@db";
import { ParsedMail, simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { parseAndStoreEmail } from "../../../../../../lib/message-payload-parser";
import { verifySendgrid, inboundIdentityFor } from "../../../../../../lib/inbound-auth";

export function getToEmails(parsed: ParsedMail): string[] {
	if (!parsed.to) return [];
	const tos = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
	return tos.flatMap((addrObj) =>
		addrObj.value.map((email) => email.address!).filter(Boolean),
	);
}

export default defineEventHandler(async (event) => {
	// Access control: request signed by SendGrid required (403 otherwise, see
	// lib/inbound-auth.ts).
	await verifySendgrid(event);
	try {
		const parts = await readMultipartFormData(event);
		if (!parts) return { ok: false, error: "No multipart body" };

		const emailPart = parts.find((p) => p.name === "email");
		if (!emailPart)
			return { ok: false, error: "No email field in inbound payload" };

		const rawMime = (emailPart.data as Buffer).toString("utf8");
		const parsed = await simpleParser(rawMime);

		const toAddress = getToEmails(parsed)[0] ?? null;

		// Access control: identity of this provider, and only one.
		const identity = await inboundIdentityFor(toAddress, "sendgrid");

		if (!identity) {
			console.log("No identity found for toAddress", toAddress);
			return { ok: false, error: "No identity found for toAddress" };
		}

		const emlId = uuidv4();
		const rawStorageKey = `eml/${identity.ownerId}/${emlId}`;

		const headers = parsed.headers as Map<string, any>;

		const userMailboxes = await db
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.identityId, identity.id));

		const inbox = userMailboxes.find((m) => m.kind === "inbox");
		const spamMb = userMailboxes.find((m) => m.kind === "spam");

		const authRes = String(headers.get("authentication-results") ?? "");
		const spfFail = /spf=\s*fail/i.test(authRes);
		const dkimFail = /dkim=\s*fail/i.test(authRes);
		const dmarcFail = /dmarc=\s*fail/i.test(authRes);
		const authSaysJunk = (spfFail && dkimFail && dmarcFail) || dmarcFail;

		await parseAndStoreEmail(rawMime, {
			ownerId: identity.ownerId,
			workspaceId: identity.workspaceId,
			mailboxId: authSaysJunk ? String(spamMb?.id) : String(inbox?.id),
			rawStorageKey,
			emlKey: emlId,
		});

		return { ok: true };
	} catch (err) {
		console.error("[Webhook] Error:", err);
		return { ok: true };
	}
});
