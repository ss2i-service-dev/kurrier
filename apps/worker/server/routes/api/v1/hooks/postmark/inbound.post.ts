import { defineEventHandler, readBody } from "h3";
import { db, mailboxes } from "@db";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { parseAndStoreEmail } from "../../../../../../lib/message-payload-parser";
import { getToEmails } from "../sendgrid/inbound.post";
import { verifyPostmark, inboundIdentityFor } from "../../../../../../lib/inbound-auth";

export default defineEventHandler(async (event) => {
	// ss2i (controle d'acces) : secret partage exige (403 sinon, cf. lib/inbound-auth.ts).
	verifyPostmark(event);
	try {
		const body = await readBody(event);

		const rawMime = (body.RawEmail as Buffer).toString("utf8");
		const parsed = await simpleParser(rawMime);

		const toAddress = getToEmails(parsed)[0] ?? null;

		// ss2i (controle d'acces) : identite de ce fournisseur, et une seule.
		const identity = await inboundIdentityFor(toAddress, "postmark");

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
		const spamStatus = String(headers.get("x-spam-status") ?? "");

		const authSaysJunk: boolean =
			(spfFail && dkimFail && dmarcFail) ||
			dmarcFail ||
			/^yes\b/i.test(spamStatus);

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
