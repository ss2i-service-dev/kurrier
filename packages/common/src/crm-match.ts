// ss2i : section « Clients » des boites pro. Un fil est rattache aux societes de la CRM
// par ses adresses EXTERIEURES ; ce module ne contient que les regles pures (sans base,
// sans reseau) : quelles identites sont « pro », quelles adresses sont a soumettre a la
// CRM, et le regroupement des reponses par societe. Memes filtres que le module
// client-mail de Lore : domaines internes et leurs sous-domaines ecartes, expediteurs
// automatiques ecartes ; les messageries grand public sont laissees a la CRM, qui
// reconnait une adresse exacte d'un contact meme chez gmail.

export const DEFAULT_CRM_URL = "https://crm.ss2i-services.fr";
export const DEFAULT_PRO_DOMAINS = "ss2i-digital.fr,ss2i-services.fr";
export const DEFAULT_INTERNAL_DOMAINS = "ss2i-digital.fr,ss2i-services.fr,ss2i.ca";

/** Expediteurs automatiques : jamais un interlocuteur (meme liste que le CRM). */
const AUTOMATED_LOCAL_PARTS = new Set([
	"noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "ne-pas-repondre",
	"nepasrepondre", "notification", "notifications", "mailer-daemon", "postmaster",
	"calendar-notification", "invitations", "bounce", "bounces",
]);

export function parseDomainList(value: string | undefined | null, fallback: string): string[] {
	const raw = value && value.trim() !== "" ? value : fallback;
	return Array.from(
		new Set(
			raw
				.split(",")
				.map((d) => d.trim().toLowerCase().replace(/^@/, ""))
				.filter(Boolean),
		),
	);
}

export function normalizeEmail(value: string | null | undefined): string | null {
	if (!value) return null;
	let s = String(value).trim().toLowerCase();
	const m = s.match(/<([^<>]+)>\s*$/);
	if (m) s = m[1].trim();
	if (!s.includes("@")) return null;
	const at = s.lastIndexOf("@");
	const local = s.slice(0, at);
	const domain = s.slice(at + 1);
	if (!local || !domain || domain.includes(" ") || !domain.includes(".")) return null;
	return `${local}@${domain}`;
}

export function domainOf(email: string): string {
	return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** Le domaine, ou l'un de ses sous-domaines (cerise2.ss2i-services.fr). */
export function isDomainIn(domain: string, domains: string[]): boolean {
	const d = domain.toLowerCase();
	return domains.some((x) => d === x || d.endsWith(`.${x}`));
}

export function isInternalAddress(email: string, internalDomains: string[]): boolean {
	return isDomainIn(domainOf(email), internalDomains);
}

export function isAutomatedAddress(email: string): boolean {
	const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
	if (AUTOMATED_LOCAL_PARTS.has(local)) return true;
	if (/^(no-?reply|do-?not-?reply|bounce|mailer-daemon)/.test(local)) return true;
	if (/(^|[.+_-])(no-?reply|donotreply)([.+_-]|$)/.test(local)) return true;
	// Adresses de rebond et de suivi (VERP, listes) : des octets aleatoires, jamais un
	// interlocuteur.
	if (local.length > 48) return true;
	return false;
}

/** Une identite est « pro » si son adresse est dans l'un des domaines configures. */
export function isProIdentity(identityValue: string | null | undefined, proDomains: string[]): boolean {
	const email = normalizeEmail(identityValue);
	if (!email) return false;
	return isDomainIn(domainOf(email), proDomains);
}

export type AddressLike = { address?: string | null; email?: string | null; e?: string | null } | string;

/** Adresses d'un champ from/to/cc/bcc tel que range en base (AddressObjectJSON ou liste). */
export function addressesOf(field: unknown): string[] {
	if (!field) return [];
	const out: string[] = [];
	const push = (v: unknown) => {
		if (!v) return;
		if (typeof v === "string") {
			// Un champ texte peut porter plusieurs adresses separees par des virgules.
			for (const part of v.split(",")) {
				const e = normalizeEmail(part);
				if (e) out.push(e);
			}
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) push(x);
			return;
		}
		if (typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.value)) {
				push(o.value);
				return;
			}
			// Un groupe (mailparser) porte ses membres dans `group`.
			if (Array.isArray(o.group)) {
				push(o.group);
				return;
			}
			const e = normalizeEmail((o.address ?? o.email ?? o.e) as string | null | undefined);
			if (e) out.push(e);
		}
	};
	push(field);
	return out;
}

/**
 * Adresses exterieures d'un lot de messages : normalisees, dedoublonnees, sans les
 * domaines internes ni les automates. Vide = pas un echange client.
 */
export function externalAddresses(
	fields: unknown[],
	internalDomains: string[],
): string[] {
	const seen = new Set<string>();
	for (const f of fields) {
		for (const e of addressesOf(f)) {
			if (seen.has(e)) continue;
			if (isInternalAddress(e, internalDomains)) continue;
			if (isAutomatedAddress(e)) continue;
			seen.add(e);
		}
	}
	return Array.from(seen);
}

export type EmailMatch = {
	email: string;
	matched: boolean;
	matchedBy: string | null;
	companyId: number | null;
	companyName: string | null;
};

export type ThreadCompany = { companyId: number; companyName: string | null; matchedBy: string };

/**
 * Societes d'un fil a partir des reponses par adresse : une societe par identifiant,
 * le type de rapprochement le plus fort retenu (adresse exacte avant domaine).
 */
export function companiesOf(matches: EmailMatch[]): ThreadCompany[] {
	const rank = (by: string | null) => (by === "email" ? 2 : by === "domain" ? 1 : 0);
	const byId = new Map<number, ThreadCompany>();
	for (const m of matches) {
		if (!m.matched || m.companyId == null) continue;
		const prev = byId.get(m.companyId);
		const by = m.matchedBy ?? "domain";
		if (!prev || rank(by) > rank(prev.matchedBy)) {
			byId.set(m.companyId, {
				companyId: m.companyId,
				companyName: m.companyName ?? prev?.companyName ?? null,
				matchedBy: by,
			});
		}
	}
	return Array.from(byId.values()).sort((a, b) => a.companyId - b.companyId);
}

/** Fiche de la societe dans la CRM (panneau Filament a la racine). */
export function crmCompanyUrl(crmUrl: string | undefined | null, companyId: number | string): string {
	const base = (crmUrl && crmUrl.trim() !== "" ? crmUrl : DEFAULT_CRM_URL).replace(/\/+$/, "");
	return `${base}/companies/${companyId}`;
}
