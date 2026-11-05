// Unsubscribe from the List-* headers of a message. Pure functions, shared by the
// worker (ingestion, backfill) and the web app (subscription key at display time, choice
// of method). mailparser stores these headers under the `list` key (list.id,
// list.unsubscribe, list["unsubscribe-post"]) and does not always expose the raw form
// (`list-unsubscribe`): both forms are read.

export type MailtoTarget = {
	address: string;
	subject: string | null;
	body: string | null;
};

export type ListUnsubscribeInfo = {
	listId: string | null;
	httpUrl: string | null;
	// Form stored in mail_subscriptions.unsubscribe_mailto: address[?subject=..&body=..],
	// without the "mailto:" scheme.
	mailto: string | null;
	oneClick: boolean;
};

export type UnsubscribeMethod = "one-click" | "mailto" | "web" | "none";

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function firstOf(v: unknown): unknown {
	return Array.isArray(v) ? v[0] : v;
}

// "<mailto:a@b?subject=x>, <https://...>" -> ["mailto:a@b?subject=x", "https://..."]
export function splitListUnsubscribe(raw: string): string[] {
	const out: string[] = [];
	const re = /<([^>]*)>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw))) {
		const s = m[1].trim();
		if (s) out.push(s);
	}
	if (!out.length) {
		// Value without angle brackets: comma separator.
		for (const p of raw.split(",")) {
			const s = p.trim();
			if (s) out.push(s);
		}
	}
	return out;
}

export function stripMailtoScheme(s: string): string {
	return s.replace(/^mailto:/i, "").trim();
}

// Address, subject and body of a stored mailto (with or without "mailto:").
export function parseMailto(stored: string | null | undefined): MailtoTarget | null {
	const s = stripMailtoScheme(asString(stored));
	if (!s) return null;
	const q = s.indexOf("?");
	const rawAddr = q === -1 ? s : s.slice(0, q);
	let address = rawAddr;
	try {
		address = decodeURIComponent(rawAddr);
	} catch {
		/* address kept as is */
	}
	address = address.trim().split(",")[0].trim();
	if (!address.includes("@")) return null;
	let subject: string | null = null;
	let body: string | null = null;
	if (q !== -1) {
		const params = new URLSearchParams(s.slice(q + 1).replace(/\+/g, "%2B"));
		subject = params.get("subject") || null;
		body = params.get("body") || null;
	}
	return { address, subject, body };
}

function listIdFrom(headers: Record<string, any>): string | null {
	const list = headers?.list;
	const id = list?.id;
	let cand =
		asString(typeof id === "string" ? id : id?.id) ||
		asString(typeof id === "string" ? "" : id?.name) ||
		asString(headers?.["list-id"]);
	if (!cand) return null;
	// Raw form "Name <id>": the identifier is between angle brackets.
	const m = cand.match(/<([^>]+)>/);
	if (m) cand = m[1];
	cand = cand.replace(/\s+/g, "");
	return cand || null;
}

export function extractListUnsubscribe(headers: Record<string, any> | null | undefined): ListUnsubscribeInfo {
	const h = headers ?? {};
	const list = h.list ?? null;
	const unsub = firstOf(list?.unsubscribe) as any;

	let httpUrl: string | null = null;
	let mailto: string | null = null;

	const fromList = asString(firstOf(unsub?.url) ?? unsub?.href);
	if (/^https?:\/\//i.test(fromList)) httpUrl = fromList;
	const mailFromList = asString(firstOf(unsub?.mail));
	if (mailFromList) mailto = stripMailtoScheme(mailFromList) || null;

	const rawUnsub = h["list-unsubscribe"];
	if (typeof rawUnsub === "string") {
		for (const part of splitListUnsubscribe(rawUnsub)) {
			if (!httpUrl && /^https?:\/\//i.test(part)) httpUrl = part;
			else if (!mailto && /^mailto:/i.test(part)) mailto = stripMailtoScheme(part) || null;
		}
	}
	if (mailto && !parseMailto(mailto)) mailto = null;

	const post =
		asString(list?.["unsubscribe-post"]?.name) ||
		asString(typeof list?.["unsubscribe-post"] === "string" ? list["unsubscribe-post"] : "") ||
		asString(h["list-unsubscribe-post"]);
	// RFC 8058: the "List-Unsubscribe=One-Click" POST only applies to an https URL.
	const oneClick =
		!!httpUrl && /^https:\/\//i.test(httpUrl) && post.toLowerCase().includes("list-unsubscribe=one-click");

	return { listId: listIdFrom(h), httpUrl, mailto, oneClick };
}

export function hostPath(url: string): string | null {
	try {
		const u = new URL(url);
		const p = (u.pathname || "/").replace(/\/+$/, "") || "/";
		return `${u.protocol}//${u.host.toLowerCase()}${p}`;
	} catch {
		return null;
	}
}

// Subscription key, stable from one message to the next of the same list and specific
// to the sender. Without a List-Id, the key of a lone unsubscribe URL (host + path) is
// shared by all customers of one routing provider (Mailjet: https://xxx.mjt.lu/unsub2):
// they were merged into a single subscription whose URL was overwritten on every
// message. The sender's domain is therefore added to the key.
export function subscriptionKeyOf(info: ListUnsubscribeInfo, fromEmail?: string | null): string | null {
	if (info.listId) return `list-id:${info.listId.toLowerCase()}`;
	const fromDomain = asString(fromEmail).toLowerCase().split("@")[1] || "";
	if (info.httpUrl) {
		const hp = hostPath(info.httpUrl);
		if (hp) return fromDomain ? `from:${fromDomain}|${hp}` : `url:${hp}`;
	}
	if (fromDomain && (info.httpUrl || info.mailto)) return `from:${fromDomain}`;
	if (info.mailto) {
		const t = parseMailto(info.mailto);
		return t ? `mailto:${t.address.toLowerCase()}` : null;
	}
	return null;
}

export function chooseUnsubscribeMethod(sub: {
	unsubscribeHttpUrl?: string | null;
	unsubscribeMailto?: string | null;
	oneClick?: boolean | null;
}): UnsubscribeMethod {
	const url = asString(sub.unsubscribeHttpUrl);
	if (sub.oneClick && /^https:\/\//i.test(url)) return "one-click";
	if (parseMailto(sub.unsubscribeMailto)) return "mailto";
	if (/^https?:\/\//i.test(url)) return "web";
	return "none";
}
