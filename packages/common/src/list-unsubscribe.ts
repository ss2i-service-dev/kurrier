// ss2i : desinscription a partir des en-tetes List-* d'un message. Fonctions pures, partagees
// par le worker (ingestion, rattrapage) et le web (cle d'abonnement a l'affichage, choix de
// la methode). mailparser range ces en-tetes sous la cle `list` (list.id, list.unsubscribe,
// list["unsubscribe-post"]) et n'expose pas toujours la forme brute (`list-unsubscribe`) :
// les deux formes sont lues.

export type MailtoTarget = {
	address: string;
	subject: string | null;
	body: string | null;
};

export type ListUnsubscribeInfo = {
	listId: string | null;
	httpUrl: string | null;
	// Forme stockee dans mail_subscriptions.unsubscribe_mailto : adresse[?subject=..&body=..],
	// sans le schema « mailto: ».
	mailto: string | null;
	oneClick: boolean;
};

export type UnsubscribeMethod = "one-click" | "mailto" | "web" | "none";

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function firstOf(v: unknown): unknown {
	return Array.isArray(v) ? v[0] : v;
}

// « <mailto:a@b?subject=x>, <https://...> » -> ["mailto:a@b?subject=x", "https://..."]
export function splitListUnsubscribe(raw: string): string[] {
	const out: string[] = [];
	const re = /<([^>]*)>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw))) {
		const s = m[1].trim();
		if (s) out.push(s);
	}
	if (!out.length) {
		// Valeur sans chevrons : separateur virgule.
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

// Adresse, sujet et corps d'un mailto stocke (avec ou sans « mailto: »).
export function parseMailto(stored: string | null | undefined): MailtoTarget | null {
	const s = stripMailtoScheme(asString(stored));
	if (!s) return null;
	const q = s.indexOf("?");
	const rawAddr = q === -1 ? s : s.slice(0, q);
	let address = rawAddr;
	try {
		address = decodeURIComponent(rawAddr);
	} catch {
		/* adresse gardee telle quelle */
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
	// Forme brute « Nom <id> » : l'identifiant est entre chevrons.
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
	// RFC 8058 : le POST « List-Unsubscribe=One-Click » ne vaut que pour une URL https.
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

// Cle d'abonnement, stable d'un message a l'autre d'une meme liste et propre a l'expediteur.
// Sans List-Id, la cle d'une URL de desinscription seule (host + chemin) est partagee par tous
// les clients d'un meme routeur (Mailjet : https://xxx.mjt.lu/unsub2) : ils se confondaient en
// un seul abonnement, dont l'URL etait ecrasee a chaque message. Le domaine de l'expediteur
// est donc ajoute a la cle.
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
