"use server";

import { eq } from "drizzle-orm";
import { decryptAdminSecrets, identities, smtpAccountSecrets } from "@db";
import { rlsClient } from "@/lib/actions/clients";
import { FormState, handleAction } from "@schema";
import { decode } from "decode-formdata";
import { revalidatePath } from "next/cache";

// Auto-reply: it lives in the mail server (JMAP VacationResponse, RFC 8621), not in the
// webmail. It therefore acts whatever client is used, and survives kurrier upgrades. The
// server is addressed with the mailbox IMAP credentials, already encrypted in the database.
//
// JMAP_URL (optional): HTTP base of the server, default http://<IMAP_HOST>:8080.

export type VacationResponse = {
	isEnabled: boolean;
	fromDate: string | null;
	toDate: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
};

const USING = [
	"urn:ietf:params:jmap:core",
	"urn:ietf:params:jmap:mail",
	"urn:ietf:params:jmap:vacationresponse",
];

async function jmapContext(identityPublicId: string) {
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx.select().from(identities).where(eq(identities.publicId, identityPublicId)),
	);
	if (!identity) throw new Error("Identity not found");
	if (!identity.smtpAccountId) {
		throw new Error("Auto-reply is only available for IMAP/SMTP identities");
	}

	const [secret] = await decryptAdminSecrets({
		linkTable: smtpAccountSecrets,
		foreignCol: smtpAccountSecrets.accountId,
		secretIdCol: smtpAccountSecrets.secretId,
		ownerId: identity.ownerId,
		parentId: String(identity.smtpAccountId),
	});
	const creds = secret?.vault?.decrypted_secret
		? JSON.parse(secret.vault.decrypted_secret)
		: {};
	const user = creds.IMAP_USERNAME || creds.SMTP_USERNAME;
	const pass = creds.IMAP_PASSWORD || creds.SMTP_PASSWORD;
	const host = creds.IMAP_HOST || creds.SMTP_HOST;
	if (!user || !pass || !host) throw new Error("Mailbox credentials not found");

	const base = String(process.env.JMAP_URL || `http://${host}:8080`).replace(/\/+$/, "");
	const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

	const sessionRes = await fetch(`${base}/.well-known/jmap`, {
		headers: { Authorization: auth, Accept: "application/json" },
		cache: "no-store",
	});
	if (!sessionRes.ok) {
		throw new Error(`Mail server refused the JMAP session (HTTP ${sessionRes.status})`);
	}
	const session = await sessionRes.json();
	const accountId: string | undefined =
		session?.primaryAccounts?.["urn:ietf:params:jmap:vacationresponse"] ??
		session?.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
		Object.keys(session?.accounts ?? {})[0];
	if (!accountId) throw new Error("No JMAP account for this mailbox");

	return { identity, accountId, apiUrl: `${base}/jmap/`, auth };
}

async function jmapCall(
	ctx: { apiUrl: string; auth: string },
	methodCalls: unknown[],
) {
	const res = await fetch(ctx.apiUrl, {
		method: "POST",
		headers: {
			Authorization: ctx.auth,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ using: USING, methodCalls }),
		cache: "no-store",
	});
	if (!res.ok) throw new Error(`JMAP request failed (HTTP ${res.status})`);
	const json = await res.json();
	const [name, payload] = json?.methodResponses?.[0] ?? [];
	if (name === "error") {
		throw new Error(`JMAP error: ${payload?.type ?? "unknown"}${payload?.description ? ` (${payload.description})` : ""}`);
	}
	return payload;
}

export async function fetchVacation(identityPublicId: string): Promise<VacationResponse> {
	const ctx = await jmapContext(identityPublicId);
	const payload = await jmapCall(ctx, [
		["VacationResponse/get", { accountId: ctx.accountId }, "0"],
	]);
	const v = payload?.list?.[0] ?? {};
	return {
		isEnabled: Boolean(v.isEnabled),
		fromDate: v.fromDate ?? null,
		toDate: v.toDate ?? null,
		subject: v.subject ?? null,
		textBody: v.textBody ?? null,
		htmlBody: v.htmlBody ?? null,
	};
}

function escapeHtml(s: string) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Browser "datetime-local" + its time zone offset -> UTC instant.
function localToUtc(value: unknown, tzOffsetMinutes: number): string | null {
	const s = String(value ?? "").trim();
	if (!s) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
	if (!m) return null;
	const [, y, mo, d, h, mi] = m.map(Number);
	const utc = Date.UTC(y, mo - 1, d, h, mi) + tzOffsetMinutes * 60_000;
	return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function saveVacation(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const form = decode(formData) as Record<string, unknown>;
		const identityPublicId = String(form.identityPublicId ?? "");
		const ctx = await jmapContext(identityPublicId);

		const tz = Number(form.tzOffset ?? 0) || 0;
		const textBody = String(form.textBody ?? "").trim();
		const subject = String(form.subject ?? "").trim();
		const isEnabled = form.isEnabled === "on" || form.isEnabled === "true";

		if (isEnabled && !textBody) {
			return { success: false, error: "The auto-reply message cannot be empty." };
		}

		const update = {
			isEnabled,
			subject: subject || null,
			textBody: textBody || null,
			htmlBody: textBody
				? `<p>${escapeHtml(textBody).replace(/\r?\n/g, "<br>")}</p>`
				: null,
			fromDate: localToUtc(form.fromDate, tz),
			toDate: localToUtc(form.toDate, tz),
		};

		const payload = await jmapCall(ctx, [
			["VacationResponse/set", { accountId: ctx.accountId, update: { singleton: update } }, "0"],
		]);
		if (payload?.notUpdated?.singleton) {
			const e = payload.notUpdated.singleton;
			throw new Error(`Mail server rejected the change: ${e.type}${e.description ? ` (${e.description})` : ""}`);
		}
		if (form.pathname) revalidatePath(String(form.pathname));
		return { success: true, message: isEnabled ? "Auto-reply enabled." : "Auto-reply saved." };
	});
}
