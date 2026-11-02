import { getServerEnv } from "@schema";
import { DEFAULT_CRM_URL } from "@common";

// ss2i : client de l'API `POST api/lore/email-match` de la CRM SS2i (meme contrat et
// meme jeton que le module client-mail de Lore). L'API prend un lot d'adresses et
// decide pour le LOT (une societe, ou aucune si les adresses menent a deux societes) :
// on l'appelle donc adresse par adresse, pour pouvoir mettre chaque reponse en cache
// et rattacher un fil a plusieurs clients. Debit limite en process (le CRM fait
// plusieurs requetes SQL par appel, dont un LIKE sur les sites web des societes).

const { CRM_URL, CRM_LORE_TOKEN } = getServerEnv();

export const CRM_MIN_INTERVAL_MS = 125; // 8 appels par seconde au plus
const TIMEOUT_MS = 8000;

export type CrmMatchResponse = {
	matched: boolean;
	matched_by: string | null;
	company: { id: number; name: string; ebp_customer_id: string | null } | null;
	contact: { id: number; name: string } | null;
};

export function crmConfigured(): boolean {
	return !!(CRM_LORE_TOKEN && CRM_LORE_TOKEN.trim() !== "");
}

export function crmBaseUrl(): string {
	return (CRM_URL && CRM_URL.trim() !== "" ? CRM_URL : DEFAULT_CRM_URL).replace(/\/+$/, "");
}

// Un seul appel a la fois, espaces d'au moins CRM_MIN_INTERVAL_MS : les jobs du worker
// crm-link partagent ce verrou quel que soit leur nombre.
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
function throttle<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(async () => {
		const wait = lastCallAt + CRM_MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastCallAt = Date.now();
		return fn();
	});
	chain = run.catch(() => undefined);
	return run;
}

export class CrmUnavailableError extends Error {}

/**
 * Societe d'une adresse selon la CRM. Rend null quand la CRM ne peut pas repondre
 * (non configuree, injoignable, reponse illisible) : l'adresse reste alors a verifier,
 * jamais marquee « sans client » a tort.
 */
export async function crmMatchEmail(email: string, fetchImpl: typeof fetch = fetch): Promise<CrmMatchResponse | null> {
	if (!crmConfigured()) return null;
	return throttle(async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const res = await fetchImpl(`${crmBaseUrl()}/api/lore/email-match`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${CRM_LORE_TOKEN}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ emails: [email] }),
				signal: controller.signal,
			});
			if (!res.ok) {
				console.warn(`[crm-link] email-match refused: HTTP ${res.status}`);
				return null;
			}
			const json: any = await res.json();
			if (!json || typeof json !== "object" || !("matched" in json)) {
				console.warn("[crm-link] email-match: unreadable response");
				return null;
			}
			return {
				matched: !!json.matched,
				matched_by: typeof json.matched_by === "string" ? json.matched_by : null,
				company:
					json.company && typeof json.company === "object" && Number.isFinite(Number(json.company.id))
						? {
								id: Number(json.company.id),
								name: String(json.company.name ?? ""),
								ebp_customer_id: json.company.ebp_customer_id == null ? null : String(json.company.ebp_customer_id),
							}
						: null,
				contact:
					json.contact && typeof json.contact === "object" && Number.isFinite(Number(json.contact.id))
						? { id: Number(json.contact.id), name: String(json.contact.name ?? "") }
						: null,
			};
		} catch (err: any) {
			console.warn(`[crm-link] email-match unreachable: ${String(err?.message ?? err)}`);
			return null;
		} finally {
			clearTimeout(timer);
		}
	});
}
