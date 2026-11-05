// Sender blocking by address or by domain (subdomains included). Pure functions shared
// by the web app (menu, confirmation, action) and the worker (reception, batches).

export type BlockKind = "address" | "domain";
export type BlockEntry = { kind: BlockKind; value: string };

export function normalizeDomain(s: string | null | undefined): string {
	return String(s ?? "")
		.trim()
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/^\*\./, "")
		.replace(/\.+$/, "");
}

export function normalizeAddress(s: string | null | undefined): string {
	const raw = String(s ?? "").trim().toLowerCase();
	const m = raw.match(/<([^>]+)>/);
	return (m ? m[1] : raw).trim();
}

export function emailDomain(email: string | null | undefined): string {
	const a = normalizeAddress(email);
	const at = a.lastIndexOf("@");
	return at === -1 ? "" : normalizeDomain(a.slice(at + 1));
}

const FREE_MAIL_EXACT = new Set([
	"gmail.com",
	"googlemail.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"msn.com",
	"aol.com",
	"ymail.com",
	"orange.fr",
	"wanadoo.fr",
	"free.fr",
	"sfr.fr",
	"neuf.fr",
	"laposte.net",
	"bbox.fr",
	"proton.me",
	"protonmail.com",
	"pm.me",
]);

// outlook.*, hotmail.*, live.*, yahoo.*, gmx.*: all extensions (outlook.fr, live.ca...).
const FREE_MAIL_FAMILIES = /^(outlook|hotmail|live|yahoo|gmx)\.[a-z]{2,3}(\.[a-z]{2})?$/;

export function isFreeMailDomain(domain: string): boolean {
	const d = normalizeDomain(domain);
	if (!d) return false;
	return FREE_MAIL_EXACT.has(d) || FREE_MAIL_FAMILIES.test(d);
}

// A domain of one of the user's identities (or its parent or subdomain) cannot be blocked.
export function isOwnDomain(domain: string, ownDomains: string[]): boolean {
	const d = normalizeDomain(domain);
	return ownDomains.some((o) => {
		const od = normalizeDomain(o);
		return !!od && (od === d || od.endsWith("." + d) || d.endsWith("." + od));
	});
}

export type BlockOptions = { address: string; domain: string | null };

// What we offer to block for a sender: always the address, the domain only if it is
// neither a public mailbox provider nor the user's own.
export function blockOptionsFor(email: string, ownDomains: string[] = []): BlockOptions {
	const address = normalizeAddress(email);
	const domain = emailDomain(address);
	const ok = !!domain && !isFreeMailDomain(domain) && !isOwnDomain(domain, ownDomains);
	return { address, domain: ok ? domain : null };
}

export function domainMatches(emailDom: string, blockedDomain: string): boolean {
	const d = normalizeDomain(emailDom);
	const b = normalizeDomain(blockedDomain);
	return !!d && !!b && (d === b || d.endsWith("." + b));
}

export function isBlockedSender(email: string | null | undefined, entries: BlockEntry[]): boolean {
	const addr = normalizeAddress(email);
	if (!addr.includes("@")) return false;
	const dom = emailDomain(addr);
	return entries.some((e) =>
		e.kind === "address" ? normalizeAddress(e.value) === addr : domainMatches(dom, e.value),
	);
}

// Messages of the blocked sender, per folder (web batches): only these are moved, never a
// whole thread automatically. The worker takes the whole thread when nothing else is left
// in it (see planMessageMove).
export function groupBlockedMessages(
	rows: Array<{ id: string; threadId: string; mailboxId: string; address: string | null }>,
	entries: BlockEntry[],
) {
	const byMailbox = new Map<string, Array<{ id: string; threadId: string }>>();
	for (const r of rows) {
		if (!isBlockedSender(r.address, entries)) continue;
		const list = byMailbox.get(r.mailboxId) ?? [];
		list.push({ id: r.id, threadId: r.threadId });
		byMailbox.set(r.mailboxId, list);
	}
	return byMailbox;
}
