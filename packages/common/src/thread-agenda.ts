// ss2i : « Ajouter a l'agenda » depuis un fil (OI 10280). Le texte du fil (historique cite
// retire, comme get_thread de l'MCP) part a un LLM (API Anthropic, sortie JSON contrainte
// par un schema) qui propose les evenements dates ; l'utilisateur les relit et les corrige,
// puis ils sont crees dans son agenda Outlook par Microsoft Graph en app-only
// (client_credentials, POST /users/{adresse}/events). Rien n'est cree sans sa validation.
// Pas de dependance : fetch direct, comme crm-api.ts (fetchImpl injectable pour les tests).
import { messageBodyText, truncate } from "./html-text";
import { stripQuotedText } from "./compose";

export const AGENDA_TIMEZONE = "Europe/Paris";
export const AGENDA_MODEL = "claude-haiku-5-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2026-10-21";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_CHARS_PER_MESSAGE = 20_000;

/** Erreur dont le message s'affiche tel quel a l'utilisateur. */
export class AgendaError extends Error {}

/**
 * Evenement propose puis valide. Heures de Paris, sans decalage.
 * - allDay : start et end en YYYY-MM-DD, end = dernier jour INCLUS (« du 7 au 11 » -> 11) ;
 * - sinon : start et end en YYYY-MM-DDTHH:mm.
 */
export type AgendaEvent = {
	title: string;
	allDay: boolean;
	start: string;
	end: string;
	location?: string;
	notes?: string;
	sourceQuote: string;
	/** Choisi a l'etape de confirmation ; absent = aucun rappel. */
	reminder?: AgendaReminder;
};

// Rappel demande a la confirmation, « Aucun rappel » par defaut (Samuel, 04/11). Journee
// entiere : minutes avant le debut a 00:00 heure de Paris (la veille a 8 h = 16 h avant = 960).
// Un changement d'heure entre le rappel et l'evenement le decale d'une heure.
export type AgendaReminder = "none" | "day-before-8h" | "2-days-8h" | "week-8h" | "15m" | "1h" | "day-before";

export const ALL_DAY_REMINDERS: { value: AgendaReminder; label: string; minutes: number | null }[] = [
	{ value: "none", label: "Aucun rappel", minutes: null },
	{ value: "day-before-8h", label: "La veille à 8 h", minutes: 24 * 60 - 8 * 60 },
	{ value: "2-days-8h", label: "2 jours avant à 8 h", minutes: 2 * 24 * 60 - 8 * 60 },
	{ value: "week-8h", label: "Une semaine avant à 8 h", minutes: 7 * 24 * 60 - 8 * 60 },
];

export const TIMED_REMINDERS: { value: AgendaReminder; label: string; minutes: number | null }[] = [
	{ value: "none", label: "Aucun rappel", minutes: null },
	{ value: "15m", label: "15 minutes avant", minutes: 15 },
	{ value: "1h", label: "1 heure avant", minutes: 60 },
	{ value: "day-before", label: "La veille", minutes: 24 * 60 },
];

export const remindersFor = (allDay: boolean) => (allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS);

/** Minutes avant le debut, null pour « aucun » ; undefined si le choix ne vaut pas pour ce type. */
export function reminderMinutes(reminder: AgendaReminder | undefined, allDay: boolean): number | null | undefined {
	const opt = remindersFor(allDay).find((o) => o.value === (reminder ?? "none"));
	return opt ? opt.minutes : undefined;
}

export type AgendaMessage = {
	from: string;
	/** ISO (date du message), null si inconnue. */
	date: string | null;
	text?: string | null;
	html?: string | null;
};

// ---------------------------------------------------------------------------
// Dates (calcul sur l'heure murale, sans fuseau : Graph l'interprete en Europe/Paris)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

function wall(y: number, mo: number, d: number, h = 0, mi = 0): Date | null {
	const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
	if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
	if (h > 23 || mi > 59) return null;
	return t;
}

function parseDate(s: string): Date | null {
	const m = DATE_RE.exec(s.trim());
	return m ? wall(+m[1], +m[2], +m[3]) : null;
}

function parseDateTime(s: string): Date | null {
	const m = DATETIME_RE.exec(s.trim());
	return m ? wall(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}

const fmtDate = (t: Date) => t.toISOString().slice(0, 10);
const fmtDateTime = (t: Date) => t.toISOString().slice(0, 16);

/** YYYY-MM-DD + n jours. */
export function addDays(date: string, n: number): string {
	const t = parseDate(date);
	if (!t) throw new AgendaError(`Date invalide : ${date}`);
	return fmtDate(new Date(t.getTime() + n * 86_400_000));
}

/** Date lisible d'un message, a Paris : « mercredi 4 novembre 2026 à 09:12 ». */
export function frenchDate(iso: string | null | undefined, withTime = true): string {
	if (!iso) return "date inconnue";
	const t = new Date(iso);
	if (Number.isNaN(t.getTime())) return "date inconnue";
	const day = new Intl.DateTimeFormat("fr-FR", {
		timeZone: AGENDA_TIMEZONE,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(t);
	if (!withTime) return day;
	const time = new Intl.DateTimeFormat("fr-FR", { timeZone: AGENDA_TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(t);
	return `${day} à ${time}`;
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

// « lundi 7 », « 1er », mois et annee a part (le recapitulatif les factorise).
const jour = (t: Date) => `${JOURS[t.getUTCDay()]} ${t.getUTCDate() === 1 ? "1er" : t.getUTCDate()}`;
const moisAn = (t: Date) => `${MOIS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
const heure = (v: string) => {
	const h = Number(v.slice(11, 13));
	const m = v.slice(14, 16);
	return m === "00" ? `${h} h` : `${h} h ${m}`;
};

/**
 * Quand, en clair, pour le recapitulatif avant creation : « lundi 7 décembre 2026, journée
 * entière », « du lundi 7 au vendredi 11 décembre 2026 », « mardi 8 décembre 2026, de 14 h à
 * 15 h 30 ». Evenement deja normalise.
 */
export function agendaWhen(e: AgendaEvent): string {
	const s = e.allDay ? parseDate(e.start) : parseDateTime(e.start);
	const f = e.allDay ? parseDate(e.end) : parseDateTime(e.end);
	if (!s || !f) return `${e.start} - ${e.end}`;
	const sameDay = fmtDate(s) === fmtDate(f);
	if (e.allDay) {
		if (sameDay) return `${jour(s)} ${moisAn(s)}, journée entière`;
		const from = moisAn(s) === moisAn(f) ? jour(s) : s.getUTCFullYear() === f.getUTCFullYear() ? `${jour(s)} ${MOIS[s.getUTCMonth()]}` : `${jour(s)} ${moisAn(s)}`;
		return `du ${from} au ${jour(f)} ${moisAn(f)}, journée entière`;
	}
	if (sameDay) return `${jour(s)} ${moisAn(s)}, de ${heure(e.start)} à ${heure(e.end)}`;
	return `du ${jour(s)} ${moisAn(s)} à ${heure(e.start)} au ${jour(f)} ${moisAn(f)} à ${heure(e.end)}`;
}

// ---------------------------------------------------------------------------
// Texte du fil et consigne du LLM
// ---------------------------------------------------------------------------

/**
 * Texte du fil pour le LLM, du plus ancien au plus recent, date de chaque message en clair
 * (jour de la semaine compris : « mardi prochain » se resout par rapport a elle). Historique
 * cite retire a partir du 2e message ; le 1er le garde (seule copie d'un mail transfere).
 */
export function agendaTranscript(input: {
	subject: string | null;
	mailbox: string;
	messages: AgendaMessage[];
	now?: Date;
}): string {
	const n = input.messages.length;
	const parts = [
		`Objet du fil : ${input.subject?.trim() || "(sans objet)"}`,
		`Agenda de : ${input.mailbox}`,
		`Date du jour : ${frenchDate((input.now ?? new Date()).toISOString(), false)}`,
		`Fuseau : ${AGENDA_TIMEZONE}`,
	];
	input.messages.forEach((m, i) => {
		let body = messageBodyText(m);
		// Reponse sous la citation (« On ... wrote: » en tete) : stripQuotedText rend tout le
		// texte, les lignes « > » partent quand meme (leurs dates relatives ne sont pas celles
		// de ce message).
		if (i > 0) body = stripQuotedText(body).split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
		parts.push(
			"",
			`===== Message ${i + 1}/${n} =====`,
			`De : ${m.from || "(inconnu)"}`,
			`Date : ${frenchDate(m.date)}`,
			"",
			truncate(body.trim(), MAX_CHARS_PER_MESSAGE).text,
		);
	});
	return parts.join("\n");
}

export const AGENDA_SYSTEM_PROMPT = `Tu lis un fil de mails et tu proposes les événements à inscrire dans l'agenda Outlook du propriétaire de la boîte (indiqué par « Agenda de »). L'utilisateur relira et corrigera chaque proposition avant toute création.

Ce qui est un événement : un rendez-vous, une réunion, un appel, une intervention, une visite, une formation, une présence prévue (stagiaire, prestataire, absence annoncée), un déplacement, une échéance ferme. Seulement ce qui a une date dans le fil, absolue ou relative.

Règles :
- Une date relative (« demain », « mardi prochain », « la semaine prochaine », « le 7 ») se résout par rapport à la date du message qui la contient, donnée dans son en-tête avec le jour de la semaine. Une date sans année est la prochaine occurrence après ce message.
- Ne rien inventer. Pas d'heure si le fil n'en donne pas : l'événement est alors sur la journée entière (allDay true). Pas d'heure de fin si le fil ne donne ni fin ni durée : end vide.
- Une période (« du 7 au 11 décembre ») est un seul événement sur la journée entière : start = premier jour, end = dernier jour inclus.
- Un même événement évoqué plusieurs fois (proposition, accord, rappel) donne une seule proposition, avec la date finalement retenue si elle a changé.
- Ignorer les dates d'envoi des messages, les lignes « Le ... a écrit : », les signatures, les mentions légales, les événements déjà passés au moment du message qui les cite, et les simples formules (« à bientôt »).
- Aucun événement daté dans le fil : liste vide.

Champs :
- title : court (60 caractères au plus), en français, dit ce qui se passe et avec qui ou pour qui, sans la date. Exemples de forme : « Réunion de chantier Mairie de X », « Intervention serveur chez Y ».
- allDay : true si aucune heure n'est donnée.
- start : « YYYY-MM-DD » si allDay, sinon « YYYY-MM-DDTHH:MM », heure de Paris.
- end : même format que start ; pour allDay, le dernier jour inclus (le jour même pour un seul jour) ; vide si l'heure de fin est inconnue.
- location : le lieu ou l'adresse s'ils sont écrits, sinon vide.
- notes : une à trois lignes de contexte utile tirées du fil (qui, quoi, contact), sans rien ajouter, sinon vide.
- sourceQuote : la phrase exacte du fil qui donne la date, recopiée telle quelle (200 caractères au plus).`;

// Aucun evenement date trouve, ou un evenement de plus voulu : l'utilisateur dit ce qu'il veut
// creer (« rappel pour relancer le client jeudi »), le LLM le met en forme a partir du fil
// (Samuel, 05/11 : « il faut demander si on veut en creer un, et ce qu'on veut creer »).
export const AGENDA_REQUEST_PROMPT = `Cette fois, l'utilisateur dit lui-même ce qu'il veut créer dans son agenda, dans « Demande de l'utilisateur » à la fin du message. Propose exactement ce qu'il demande (en général un seul événement), et rien d'autre du fil.

Règles propres à cette demande (elles priment sur les règles ci-dessus) :
- Une date relative de la demande (« demain », « jeudi », « dans une semaine », « lundi prochain ») se résout par rapport à la date du jour, pas à celle des messages.
- Sans date dans la demande : le prochain jour ouvré (lundi à vendredi) après la date du jour.
- Un rappel, une relance, un appel ou une tâche à faire sans heure donnée : à 09:00, fin à 09:15. Ailleurs, sans heure : journée entière.
- title : ce qu'il faut faire et avec qui, tiré du fil (« Relancer Franck Martin : devis serveur »), 60 caractères au plus.
- notes : une à trois lignes utiles tirées du fil pour faire l'action (objet, dernier échange, contact).
- sourceQuote : vide.`;

/** Message envoye au LLM : le fil, puis la demande de l'utilisateur s'il y en a une. */
export function agendaUserContent(transcript: string, request?: string | null): string {
	const r = request?.trim();
	return r ? `${transcript}\n\n===== Demande de l'utilisateur =====\n${r.slice(0, 1000)}` : transcript;
}

export const AGENDA_SCHEMA = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					allDay: { type: "boolean" },
					start: { type: "string", description: "YYYY-MM-DD (allDay) ou YYYY-MM-DDTHH:MM, heure de Paris" },
					end: { type: "string", description: "Meme format que start ; allDay : dernier jour inclus ; vide si inconnue" },
					location: { type: "string" },
					notes: { type: "string" },
					sourceQuote: { type: "string" },
				},
				required: ["title", "allDay", "start", "end", "location", "notes", "sourceQuote"],
				additionalProperties: false,
			},
		},
	},
	required: ["events"],
	additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Validation (sortie du LLM, puis saisie de l'utilisateur)
// ---------------------------------------------------------------------------

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Evenement propre ou message d'erreur. Fin absente : le jour meme (journee entiere) ou une
 * heure apres le debut (proposition visible et modifiable avant creation). Une date sans
 * heure donne une journee entiere.
 */
export function normalizeAgendaEvent(raw: unknown): { event: AgendaEvent } | { error: string } {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const title = clip(r.title, 255);
	if (!title) return { error: "Titre manquant" };
	const startRaw = clip(r.start, 40);
	const endRaw = clip(r.end, 40);
	const location = clip(r.location, 255) || undefined;
	const notes = clip(r.notes, 4000) || undefined;
	const sourceQuote = clip(r.sourceQuote, 500);
	const reminder = ((typeof r.reminder === "string" && r.reminder) || "none") as AgendaReminder;

	const startDt = parseDateTime(startRaw);
	const startD = parseDate(startRaw);
	const allDay = r.allDay === true || (!startDt && !!startD);
	if (reminderMinutes(reminder, allDay) === undefined) return { error: "Rappel invalide pour ce type d'événement" };
	if (allDay) {
		const s = startD ?? (startDt ? parseDate(fmtDate(startDt)) : null);
		if (!s) return { error: `Date de début invalide : ${startRaw || "(vide)"}` };
		const e = parseDate(endRaw) ?? (parseDateTime(endRaw) ? parseDate(endRaw.slice(0, 10)) : null) ?? s;
		if (e < s) return { error: "La fin précède le début" };
		return { event: { title, allDay: true, start: fmtDate(s), end: fmtDate(e), location, notes, sourceQuote, reminder } };
	}
	if (!startDt) return { error: `Date ou heure de début invalide : ${startRaw || "(vide)"}` };
	const e = parseDateTime(endRaw) ?? new Date(startDt.getTime() + 3_600_000);
	if (e <= startDt) return { error: "La fin doit suivre le début" };
	return { event: { title, allDay: false, start: fmtDateTime(startDt), end: fmtDateTime(e), location, notes, sourceQuote, reminder } };
}

/** Propositions du LLM ({ events: [...] }) : les invalides sont ecartees. */
export function parseAgendaEvents(raw: unknown): AgendaEvent[] {
	const list = raw && typeof raw === "object" && Array.isArray((raw as any).events) ? (raw as any).events : [];
	const out: AgendaEvent[] = [];
	for (const item of list) {
		const n = normalizeAgendaEvent(item);
		if ("event" in n) out.push(n.event);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Analyse par le LLM
// ---------------------------------------------------------------------------

export type AnthropicConfig = { apiKey: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Evenements dates proposes pour le texte d'un fil (agendaTranscript), ou ce que demande l'utilisateur (request). */
export async function extractAgendaEvents(cfg: AnthropicConfig, transcript: string, request?: string | null): Promise<AgendaEvent[]> {
	const doFetch = cfg.fetchImpl ?? fetch;
	const asked = !!request?.trim();
	const payload = JSON.stringify({
		model: cfg.model ?? AGENDA_MODEL,
		max_tokens: 16000,
		system: asked ? `${AGENDA_SYSTEM_PROMPT}\n\n${AGENDA_REQUEST_PROMPT}` : AGENDA_SYSTEM_PROMPT,
		messages: [{ role: "user", content: agendaUserContent(transcript, request) }],
		output_config: { effort: "medium", format: { type: "json_schema", schema: AGENDA_SCHEMA } },
	});
	let res: Response | null = null;
	// Surcharge ou limite de debit passageres : un second essai.
	for (let attempt = 0; attempt < 2; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 90_000);
		try {
			res = await doFetch(ANTHROPIC_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": cfg.apiKey,
					"anthropic-version": ANTHROPIC_VERSION,
				},
				body: payload,
				signal: controller.signal,
			});
		} catch (err: any) {
			if (attempt === 0) continue;
			throw new AgendaError(
				err?.name === "AbortError" ? "L'analyse a pris trop de temps, réessayez." : `Service d'analyse injoignable : ${err?.message ?? err}`,
			);
		} finally {
			clearTimeout(timer);
		}
		if ((res.status === 429 || res.status >= 500) && attempt === 0) {
			const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
			await sleep(wait * 1000);
			continue;
		}
		break;
	}
	if (!res) throw new AgendaError("Service d'analyse injoignable.");
	const data: any = await res.json().catch(() => null);
	if (!res.ok) {
		const detail = data?.error?.message ? ` : ${data.error.message}` : "";
		if (res.status === 401 || res.status === 403) throw new AgendaError(`Clé ANTHROPIC_API_KEY refusée (HTTP ${res.status})${detail}`);
		throw new AgendaError(`L'analyse a échoué (HTTP ${res.status})${detail}`);
	}
	if (data?.stop_reason === "refusal") throw new AgendaError("Le modèle a refusé d'analyser ce fil.");
	if (data?.stop_reason === "max_tokens") throw new AgendaError("Réponse du modèle tronquée : fil trop long ou trop d'événements.");
	const text = (Array.isArray(data?.content) ? data.content : [])
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new AgendaError("Réponse du modèle illisible.");
	}
	return parseAgendaEvents(parsed);
}

// ---------------------------------------------------------------------------
// Microsoft Graph (app-only)
// ---------------------------------------------------------------------------

export type GraphConfig = { tenant: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch };

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Corps de POST /users/{adresse}/events. Journee entiere : debut a 00:00, fin au lendemain du
 * dernier jour a 00:00 (convention Graph), disponibilite « libre ». Rappel : celui choisi a la
 * confirmation (isReminderOn false pour « aucun »). Corps : notes puis lien vers le fil.
 */
export function graphEventBody(e: AgendaEvent, opts: { threadUrl?: string; threadSubject?: string | null } = {}) {
	const html: string[] = [];
	if (e.notes) html.push(`<p>${escapeHtml(e.notes).replace(/\n/g, "<br>")}</p>`);
	if (opts.threadUrl) {
		const label = opts.threadSubject?.trim() ? `Fil « ${escapeHtml(opts.threadSubject.trim())} » dans courrier` : "Fil dans courrier";
		html.push(`<p><a href="${escapeHtml(opts.threadUrl)}">${label}</a></p>`);
	}
	const body: Record<string, unknown> = {
		subject: e.title,
		isAllDay: e.allDay,
		start: { dateTime: e.allDay ? `${e.start}T00:00:00` : `${e.start}:00`, timeZone: AGENDA_TIMEZONE },
		end: { dateTime: e.allDay ? `${addDays(e.end, 1)}T00:00:00` : `${e.end}:00`, timeZone: AGENDA_TIMEZONE },
		body: { contentType: "HTML", content: html.join("\n") },
	};
	if (e.allDay) body.showAs = "free";
	// Rappel choisi a la confirmation, « aucun » par defaut : jamais celui de Graph (15 min).
	const minutes = reminderMinutes(e.reminder, e.allDay) ?? null;
	body.isReminderOn = minutes !== null;
	if (minutes !== null) body.reminderMinutesBeforeStart = minutes;
	if (e.location) body.location = { displayName: e.location };
	return body;
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

export async function graphToken(cfg: GraphConfig): Promise<string> {
	const key = `${cfg.tenant}:${cfg.clientId}`;
	const hit = tokens.get(key);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
	const res = await (cfg.fetchImpl ?? fetch)(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret,
			scope: "https://graph.microsoft.com/.default",
			grant_type: "client_credentials",
		}).toString(),
	});
	const data: any = await res.json().catch(() => null);
	if (!res.ok || !data?.access_token) {
		throw new AgendaError(`Connexion à Microsoft Graph refusée (HTTP ${res.status}${data?.error ? `, ${data.error}` : ""}) : vérifier GRAPH_TENANT, GRAPH_CLIENT_ID et GRAPH_CLIENT_SECRET.`);
	}
	tokens.set(key, { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3000) * 1000 });
	return data.access_token;
}

/** Cree l'evenement dans l'agenda par defaut de la boite. */
export async function createGraphEvent(cfg: GraphConfig, mailbox: string, body: Record<string, unknown>): Promise<{ id: string; webLink?: string }> {
	const token = await graphToken(cfg);
	const res = await (cfg.fetchImpl ?? fetch)(`${GRAPH}/users/${encodeURIComponent(mailbox)}/events`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data: any = await res.json().catch(() => null);
	if (res.ok && data?.id) return { id: String(data.id), webLink: data.webLink ? String(data.webLink) : undefined };
	const code = String(data?.error?.code ?? "");
	if (res.status === 404 || code === "ErrorInvalidUser" || code === "MailboxNotEnabledForRESTAPI") {
		throw new AgendaError(`${mailbox} n'est pas une boîte du tenant Microsoft 365 : impossible d'écrire dans son agenda Outlook.`);
	}
	if (res.status === 401 || res.status === 403) {
		throw new AgendaError(`Microsoft Graph refuse l'écriture dans l'agenda de ${mailbox} (HTTP ${res.status}) : permission applicative Calendars.ReadWrite à vérifier.`);
	}
	throw new AgendaError(`Création refusée par Microsoft Graph (HTTP ${res.status}${data?.error?.message ? ` : ${data.error.message}` : ""}).`);
}

/** Adresses de BRIDGE_MAILBOXES (minuscules). */
export function parseMailboxList(raw: string | null | undefined): string[] {
	return String(raw ?? "")
		.split(/[,;\s]+/)
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.includes("@"));
}
