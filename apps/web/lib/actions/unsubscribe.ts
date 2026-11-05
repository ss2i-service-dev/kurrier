"use server";

import { rlsClient } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { getRedis } from "@/lib/actions/get-redis";
import { assertPublicHttpsUrl } from "@/lib/safe-public-url";
import { publicHttpRequest } from "@common/safe-http";
import { assertMessageAccess } from "@/lib/authz";
import { identities, mailboxes, mailSubscriptions, messages } from "@db";
import { handleAction, type FormState } from "@schema";
import {
	blockOptionsFor,
	chooseUnsubscribeMethod,
	emailDomain,
	parseMailto,
	type UnsubscribeMethod,
} from "@common";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// One-click unsubscribe from the mail header (mail-unsubscriber.tsx).
//  - one-click (RFC 8058, https): server-side POST, 2xx = success, otherwise the error is shown;
//  - mailto: unsubscribe mail sent from the identity that received the message, through the
//    normal send queue (same payload as the editor);
//  - web link only: nothing is done server-side, the interface opens the page (pending status).

export type UnsubscribeResult = {
	method: UnsubscribeMethod;
	status: "unsubscribed" | "pending";
	// Domain of the sender, for the result message.
	domain: string;
	// Page to open (web method).
	openUrl?: string;
	// What can be offered to block next (domain only if it is not a public mail domain).
	block: { address: string; domain: string | null };
};

const POST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAIL_SEND_TIMEOUT_MS = 60_000;

async function oneClickPost(rawUrl: string) {
	let url = (await assertPublicHttpsUrl(rawUrl)).toString();
	let method = "POST";
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		// Public address re-checked at connection time (DNS rebinding).
		const res = await publicHttpRequest(url, {
			method,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
			timeoutMs: POST_TIMEOUT_MS,
		});
		if (res.status >= 200 && res.status < 300) return;
		if ([301, 302, 303, 307, 308].includes(res.status)) {
			const loc = res.location;
			if (!loc) throw new Error(`Unsubscribe server answered ${res.status} without a location`);
			url = (await assertPublicHttpsUrl(new URL(loc, url).toString())).toString();
			// 301, 302, 303: the browser replays as GET; 307, 308 keep the POST.
			if ([301, 302, 303].includes(res.status)) method = "GET";
			continue;
		}
		throw new Error(`Unsubscribe server answered HTTP ${res.status}`);
	}
	throw new Error("Too many redirects from the unsubscribe server");
}

function escapeHtml(s: string) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendUnsubscribeMail(opts: {
	userId: string;
	messageRowId: string;
	mailtoStored: string;
}) {
	const target = parseMailto(opts.mailtoStored);
	if (!target) throw new Error("Invalid unsubscribe address");
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ mailbox: mailboxes, identity: identities })
			.from(messages)
			.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
			.innerJoin(identities, eq(identities.id, mailboxes.identityId))
			.where(eq(messages.id, opts.messageRowId))
			.limit(1),
	);
	if (!row) throw new Error("Message not found");
	const boxes = await rls((tx) =>
		tx.select().from(mailboxes).where(eq(mailboxes.identityId, row.identity.id)),
	);
	const sent = boxes.find((b) => b.kind === "sent");
	const inbox = boxes.find((b) => b.kind === "inbox");
	if (!sent || !inbox) throw new Error("Required folders (inbox and sent) not found for this identity");

	const text = target.body || "unsubscribe";
	const newMessageId = crypto.randomUUID();
	// Same payload as the editor form (see sendMail and lib/mcp/tools.ts).
	const payload = {
		identityId: row.identity.id,
		sentMailboxId: sent.id,
		mailboxId: inbox.id,
		senderUserId: opts.userId,
		to: [target.address],
		cc: [],
		bcc: [],
		subject: target.subject || "unsubscribe",
		text,
		html: `<p>${escapeHtml(text)}</p>`,
		mode: "new",
		includeSignature: "false",
		newMessageId,
		apiMessageId: newMessageId,
		attachments: "[]",
		// send-mail.ts adds the X-Kurrier-Auto: unsubscribe header and learns nothing from the
		// recipient (often unsubscribe-xxx@): no address book, no suggestions.
		autoMail: "unsubscribe",
	};
	const { sendMailQueue, sendMailEvents } = await getRedis();
	const job = await sendMailQueue.add("send-and-reconcile", payload, {
		jobId: `unsubscribe-${newMessageId}`,
	});
	await job.waitUntilFinished(sendMailEvents, MAIL_SEND_TIMEOUT_MS);
}

export async function unsubscribeFromMail(input: {
	mailSubscriptionId: string;
	messageId: string;
	pathname?: string;
}): Promise<FormState<UnsubscribeResult>> {
	return handleAction(async () => {
		const user = await isSignedIn();
		if (!user?.id) return { success: false, error: "Not authenticated" };
		const rls = await rlsClient();
		const [sub] = await rls((tx) =>
			tx
				.select()
				.from(mailSubscriptions)
				.where(and(eq(mailSubscriptions.id, input.mailSubscriptionId), eq(mailSubscriptions.ownerId, user.id)))
				.limit(1),
		);
		if (!sub) return { success: false, error: "Subscription not found" };

		// The message the unsubscribe starts from is a message the user can see (their
		// sending identity for a mailto).
		const msg = await assertMessageAccess(String(input.messageId ?? "")).catch(() => null);
		if (!msg) return { success: false, error: "Message not found" };
		const fromAddress = String((msg?.from as any)?.value?.[0]?.address ?? "").trim().toLowerCase();
		let domain = emailDomain(fromAddress);
		if (!domain && sub.unsubscribeHttpUrl) {
			try {
				domain = new URL(sub.unsubscribeHttpUrl).hostname;
			} catch {
				/* unknown domain */
			}
		}

		const ownDomains = (await rls((tx) => tx.select({ value: identities.value }).from(identities))).map((r) =>
			r.value.includes("@") ? emailDomain(r.value) : r.value.toLowerCase(),
		);
		const block = blockOptionsFor(fromAddress || `x@${domain}`, ownDomains);

		const method = chooseUnsubscribeMethod(sub);
		const base = { method, domain, block };
		const setStatus = async (status: "unsubscribed" | "pending") => {
			await rls((tx) =>
				tx
					.update(mailSubscriptions)
					.set({
						status,
						unsubscribedAt: status === "unsubscribed" ? new Date() : null,
						updatedAt: new Date(),
					})
					.where(eq(mailSubscriptions.id, sub.id)),
			);
			if (input.pathname) revalidatePath(input.pathname);
		};

		if (method === "one-click") {
			await oneClickPost(sub.unsubscribeHttpUrl!);
			await setStatus("unsubscribed");
			return { success: true, data: { ...base, status: "unsubscribed" as const } };
		}
		if (method === "mailto") {
			await sendUnsubscribeMail({
				userId: user.id,
				messageRowId: input.messageId,
				mailtoStored: sub.unsubscribeMailto!,
			});
			await setStatus("unsubscribed");
			return { success: true, data: { ...base, status: "unsubscribed" as const } };
		}
		if (method === "web") {
			await setStatus("pending");
			return {
				success: true,
				data: { ...base, status: "pending" as const, openUrl: sub.unsubscribeHttpUrl! },
			};
		}
		return { success: false, error: "No unsubscribe method in this message" };
	});
}

// Web link opened, then completed by the user on the sender's page.
export async function confirmUnsubscribed(input: {
	mailSubscriptionId: string;
	pathname?: string;
}): Promise<FormState> {
	return handleAction(async () => {
		const user = await isSignedIn();
		if (!user?.id) return { success: false, error: "Not authenticated" };
		const rls = await rlsClient();
		await rls((tx) =>
			tx
				.update(mailSubscriptions)
				.set({ status: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() })
				.where(and(eq(mailSubscriptions.id, input.mailSubscriptionId), eq(mailSubscriptions.ownerId, user.id))),
		);
		if (input.pathname) revalidatePath(input.pathname);
		return { success: true };
	});
}
