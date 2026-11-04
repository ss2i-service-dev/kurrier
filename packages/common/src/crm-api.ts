// ss2i : recherche d'une societe dans la CRM SS2i pour le rattachement manuel d'un fil
// (« Rattacher a un client... », outil MCP search_crm_companies, OI 10270). Meme jeton que
// le rattachement automatique (CRM_LORE_TOKEN, routes api/lore/* de la CRM). Deux sources :
//   - GET api/lore/company-search?q=&limit= -> { companies: [{ id, name, ebp_customer_id }] },
//     recherche par nom dans toute la CRM. Route a ajouter cote CRM : tant qu'elle repond 404,
//     cette source est ignoree sans erreur ;
//   - POST api/lore/email-match (existante) quand la saisie est une adresse ou un domaine :
//     la societe de cette adresse ou de ce domaine, meme si aucun fil n'en parle encore.
// Rend [] quand la CRM n'est pas configuree ou ne repond pas : l'appelant complete avec les
// societes deja connues (crm_companies).
import { DEFAULT_CRM_URL } from "./crm-match";

export type CrmApiConfig = {
	crmUrl?: string | null;
	token?: string | null;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
};

export type CrmCompanyHit = { id: number; name: string; ebpCustomerId: string | null };

function companyOf(raw: any): CrmCompanyHit | null {
	if (!raw || typeof raw !== "object") return null;
	const id = Number(raw.id);
	const name = String(raw.name ?? "").trim();
	if (!Number.isInteger(id) || id <= 0 || !name) return null;
	return { id, name, ebpCustomerId: raw.ebp_customer_id == null ? null : String(raw.ebp_customer_id) };
}

/**
 * Adresse a soumettre a email-match pour une saisie : l'adresse elle-meme, ou pour un
 * domaine (« acme.fr », « @acme.fr », « https://www.acme.fr/contact ») une adresse de ce
 * domaine (la CRM rapproche aussi par domaine). null si la saisie n'est ni l'un ni l'autre.
 */
export function emailForCompanyQuery(query: string): string | null {
	const q = query.trim().toLowerCase();
	if (/^[^\s@<>,;]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(q)) return q;
	const host = q
		.replace(/^[a-z]+:\/\//, "")
		.replace(/^@/, "")
		.replace(/[/?#].*$/, "")
		.replace(/^www\./, "");
	if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return `contact@${host}`;
	return null;
}

async function crmCall(cfg: CrmApiConfig, path: string, init: RequestInit): Promise<any | null> {
	const token = cfg.token?.trim();
	if (!token) return null;
	const base = (cfg.crmUrl && cfg.crmUrl.trim() !== "" ? cfg.crmUrl : DEFAULT_CRM_URL).replace(/\/+$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 6000);
	try {
		const res = await (cfg.fetchImpl ?? fetch)(`${base}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
			signal: controller.signal,
		});
		if (!res.ok) {
			if (res.status !== 404) console.warn(`[crm-search] ${path.split("?")[0]} refused: HTTP ${res.status}`);
			return null;
		}
		return await res.json();
	} catch (err: any) {
		console.warn(`[crm-search] ${path.split("?")[0]} unreachable: ${String(err?.message ?? err)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Societes de la CRM qui correspondent a la saisie (nom, ou adresse / domaine). */
export async function crmSearchCompanies(cfg: CrmApiConfig, query: string, limit = 20): Promise<CrmCompanyHit[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	const email = emailForCompanyQuery(q);
	const [byName, byEmail] = await Promise.all([
		crmCall(cfg, `/api/lore/company-search?q=${encodeURIComponent(q)}&limit=${limit}`, { method: "GET" }),
		email ? crmCall(cfg, "/api/lore/email-match", { method: "POST", body: JSON.stringify({ emails: [email] }) }) : null,
	]);
	const out = new Map<number, CrmCompanyHit>();
	const matched = byEmail?.matched ? companyOf(byEmail.company) : null;
	if (matched) out.set(matched.id, matched);
	for (const raw of Array.isArray(byName?.companies) ? byName.companies : []) {
		const c = companyOf(raw);
		if (c && !out.has(c.id)) out.set(c.id, c);
	}
	return [...out.values()].slice(0, limit);
}
