// ss2i : « Répondre avec Lore » depuis un fil ouvert (OI 10288). Le fil (historique cité
// retiré, comme pour l'agenda) part à Lore avec la consigne facultative de l'utilisateur ;
// Lore rédige le corps d'une réponse, dont courrier fait un brouillon de réponse dans le fil
// (apps/web/lib/actions/thread-lore.ts) que l'utilisateur relit dans l'éditeur. Rien n'est
// envoyé. Contrat fixé avec Lore (ne pas le changer d'un seul côté) :
//   POST ${LORE_URL}/api/v1/mail/reply-draft
//   Authorization: Bearer ${LORE_APP_TOKEN} ; X-Lore-Act-As: <email du compte courrier>
//   { mailbox, subject, messages: [{ from, to, cc, date, text }], instruction?, crm_company_ids, locale }
//   (ordre chronologique, le dernier message est celui auquel on répond ; 60 messages et
//   ~12 000 caractères par message au plus, coupés ici aussi)
//   200 { body_text, body_html, model, sources: [{ title, url }] } ; erreur { message } en
//   français, affiché tel quel.
// Pas de dépendance ni de base : fetch direct (fetchImpl injectable pour les tests).
import { stripSubjectPrefixes } from "./subject";
import { htmlToText, messageBodyText } from "./html-text";
import { stripQuotedText, textToHtml } from "./compose";

export const LORE_REPLY_PATH = "/api/v1/mail/reply-draft";
export const LORE_MAX_MESSAGES = 60;
export const LORE_MAX_CHARS_PER_MESSAGE = 12_000;
export const LORE_MAX_INSTRUCTION = 2_000;
// Lore se donne jusqu'à 120 s pour rédiger : un peu de marge pour le réseau.
export const LORE_TIMEOUT_MS = 130_000;

/** Erreur dont le message s'affiche tel quel à l'utilisateur. */
export class LoreError extends Error {}

/** Variables du service web absentes (bouton expliqué au lieu d'un appel voué à l'échec). */
/**
 * Compte Lore au nom duquel rediger (X-Lore-Act-As). Le compte courrier peut avoir une autre
 * adresse que le compte Lore (samuel@ss2i.ca dans courrier, samuel@ss2i-digital.fr dans Lore,
 * 05/11/2026) : on prend l'identite pro du fil, sinon la premiere identite pro de l'utilisateur,
 * sinon l'adresse du compte.
 */
export function loreActAs(input: {
	accountEmail: string;
	threadIdentity?: string | null;
	identities: (string | null | undefined)[];
	proDomains: string[];
}): string {
	const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
	const isPro = (v: string) => {
		const at = v.lastIndexOf("@");
		return at > 0 && input.proDomains.includes(v.slice(at + 1));
	};
	const thread = norm(input.threadIdentity);
	if (thread && isPro(thread)) return thread;
	const pro = input.identities.map(norm).filter((v) => v && isPro(v)).sort();
	return pro[0] ?? norm(input.accountEmail);
}

export function loreConfigMissing(env: { LORE_URL?: string; LORE_APP_TOKEN?: string }): string[] {
	return (["LORE_URL", "LORE_APP_TOKEN"] as const).filter((k) => !env[k]?.trim());
}

export const loreConfigMessage = (missing: string[]) =>
	`Répondre avec Lore n'est pas configuré sur le serveur : ${missing.length > 1 ? "variables manquantes" : "variable manquante"} ${missing.join(", ")} (service web).`;

export type LoreThreadMessage = {
	from: string;
	to: string[];
	cc: string[];
	date: string | null;
	text?: string | null;
	html?: string | null;
	attachments?: string[];
};

export type LoreReplyRequest = {
	mailbox: string;
	subject: string;
	messages: { from: string; to: string[]; cc: string[]; date: string | null; text: string }[];
	instruction?: string;
	crm_company_ids: number[];
	locale: "fr";
};

export type LoreSource = { title: string; url: string };

export type LoreReply = {
	bodyText: string;
	bodyHtml: string;
	model: string | null;
	sources: LoreSource[];
};

/** Texte coupé à `max` caractères, mention de la coupe comprise (Lore refuse au-delà). */
export function clipLoreText(text: string, max = LORE_MAX_CHARS_PER_MESSAGE): string {
	if (text.length <= max) return text;
	const note = (n: number) => `\n[… message tronqué, ${n} caractères omis]`;
	const keep = max - note(text.length).length;
	return `${text.slice(0, keep).trimEnd()}${note(text.length - keep)}`;
}

/**
 * Corps de la requête à Lore. Messages en ordre chronologique, le dernier est celui auquel
 * on répond ; au-delà de 60, les plus anciens partent. Historique cité retiré à partir du
 * 2e message du fil (le 1er le garde : seule copie d'un mail transféré), comme le texte du
 * fil pour l'agenda (agendaTranscript). Noms des pièces jointes en fin de texte.
 */
export function loreReplyRequest(input: {
	mailbox: string;
	subject: string | null;
	messages: LoreThreadMessage[];
	instruction?: string | null;
	crmCompanyIds?: number[];
}): LoreReplyRequest {
	const all = input.messages.map((m, i) => {
		let body = messageBodyText(m);
		if (i > 0) body = stripQuotedText(body).split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
		body = body.trim();
		const files = (m.attachments ?? []).filter(Boolean);
		if (files.length) body = `${body}${body ? "\n\n" : ""}[Pièces jointes : ${files.join(", ")}]`;
		return {
			from: m.from,
			to: m.to,
			cc: m.cc,
			date: m.date,
			text: clipLoreText(body || "(message sans texte)"),
		};
	});
	const instruction = (input.instruction ?? "").trim().slice(0, LORE_MAX_INSTRUCTION);
	return {
		mailbox: input.mailbox.trim().toLowerCase(),
		subject: (input.subject ?? "").trim() || "(sans objet)",
		messages: all.slice(-LORE_MAX_MESSAGES),
		...(instruction ? { instruction } : {}),
		crm_company_ids: Array.from(new Set((input.crmCompanyIds ?? []).filter((n) => Number.isInteger(n)))),
		locale: "fr",
	};
}

// Message d'une réponse en erreur sans { message } lisible (page HTML d'un proxy, etc.).
export function loreHttpError(status: number): string {
	if (status === 401 || status === 403) return `Lore a refusé l'accès (HTTP ${status}) : vérifier LORE_APP_TOKEN (service web).`;
	if (status === 404) return `Lore ne répond pas sur ${LORE_REPLY_PATH} (HTTP 404) : rédaction de réponses pas encore déployée chez Lore, ou LORE_URL erroné.`;
	if (status === 429) return "Lore est saturé (HTTP 429) : réessayez dans une minute.";
	if (status >= 500) return `Lore a rencontré une erreur (HTTP ${status}) : réessayez dans un instant.`;
	return `Lore a répondu une erreur HTTP ${status}.`;
}

export type LoreConfig = {
	url: string;
	token: string;
	/** Adresse du compte courrier de l'utilisateur (X-Lore-Act-As). */
	actAs: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
};

/** Corps de réponse rédigé par Lore (une seule tentative : la rédaction est longue). */
export async function requestLoreReply(cfg: LoreConfig, body: LoreReplyRequest): Promise<LoreReply> {
	const doFetch = cfg.fetchImpl ?? fetch;
	const timeoutMs = cfg.timeoutMs ?? LORE_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let res: Response;
	let raw = "";
	try {
		res = await doFetch(`${cfg.url.trim().replace(/\/+$/, "")}${LORE_REPLY_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cfg.token.trim()}`,
				"X-Lore-Act-As": cfg.actAs.trim().toLowerCase(),
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		raw = await res.text();
	} catch (err: any) {
		if (err?.name === "AbortError" || err?.name === "TimeoutError") {
			throw new LoreError(`Lore n'a pas répondu en ${Math.ceil(timeoutMs / 1000)} s : réessayez dans un instant.`);
		}
		const code = err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
		throw new LoreError(`Lore est injoignable (${code}) : réessayez dans un instant, ou vérifier LORE_URL (service web).`);
	} finally {
		clearTimeout(timer);
	}
	let data: any = null;
	try {
		data = raw ? JSON.parse(raw) : null;
	} catch {
		data = null;
	}
	if (!res.ok) {
		const message = typeof data?.message === "string" ? data.message.trim() : "";
		throw new LoreError(message || loreHttpError(res.status));
	}
	if (!data || typeof data !== "object") throw new LoreError("Réponse de Lore illisible (pas du JSON) : vérifier LORE_URL (service web).");
	const bodyText = typeof data?.body_text === "string" ? data.body_text.replace(/\r/g, "").trim() : "";
	const bodyHtml = typeof data?.body_html === "string" ? data.body_html.trim() : "";
	if (!bodyText && !bodyHtml) throw new LoreError("Lore n'a renvoyé aucun texte de réponse.");
	const sources: LoreSource[] = (Array.isArray(data?.sources) ? data.sources : [])
		.map((s: any) => ({ title: String(s?.title ?? "").trim(), url: String(s?.url ?? "").trim() }))
		.filter((s: LoreSource) => s.title || s.url);
	return { bodyText, bodyHtml, model: typeof data?.model === "string" ? data.model : null, sources };
}

/**
 * Corps du brouillon. Le HTML est refait depuis le texte (paragraphes échappés, même forme
 * que le MCP) : rien de ce que Lore a pu reprendre d'un mail entrant ne passe tel quel
 * dans le HTML de l'utilisateur. body_html ne sert que si body_text manque.
 */
export function loreDraftBody(reply: Pick<LoreReply, "bodyText" | "bodyHtml">): { text: string; html: string } {
	const text = reply.bodyText || htmlToText(reply.bodyHtml);
	return { text, html: textToHtml(text) };
}

/**
 * Destinataires du brouillon : ceux de « Répondre à tous » (replyRecipients, calculés comme
 * dans l'éditeur), sauf quand le message auquel on répond est de nous (relance) : on écrit
 * alors à ses destinataires, sans nos adresses (sinon le brouillon nous serait adressé).
 */
export function loreDraftRecipients(
	computed: { to: string[]; cc: string[] },
	replied: { from: string[]; to: string[]; cc: string[] },
	own: string[],
): { to: string[]; cc: string[] } {
	const ownSet = new Set(own.map((a) => a.trim().toLowerCase()));
	const fromUs = replied.from.some((a) => ownSet.has(a.trim().toLowerCase()));
	if (!fromUs) return computed;
	const seen = new Set<string>();
	const keep = (list: string[]) =>
		list.filter((a) => {
			const key = a.trim().toLowerCase();
			if (!key || ownSet.has(key) || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const to = keep(replied.to);
	const cc = keep(replied.cc);
	return to.length ? { to, cc } : cc.length ? { to: cc, cc: [] } : computed;
}

/** Objet du brouillon, comme l'éditeur pour une réponse (editor-header.tsx). */
export function loreReplySubject(subject: string | null | undefined): string {
	return stripSubjectPrefixes(subject);
}
