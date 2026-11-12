// ss2i : programmer l'envoi (partie pure, sans base ni Redis ; cf. apps/web/test/schedule-send.ts).
// Raccourcis du menu, verification de l'heure demandee, formatage 24 h de « programme pour ».
import { dayjsExtended } from "./day-js-extended";

// Une heure deja passee de plus d'une minute est refusee ; en dessous, l'envoi part tout de suite.
export const SCHEDULE_PAST_TOLERANCE_MS = 60_000;

export type ScheduleCheck =
	| { ok: true; at: Date; delayMs: number }
	| { ok: false; reason: "invalid" | "past" };

export function validateScheduledAt(raw: unknown, now: number = Date.now()): ScheduleCheck {
	const text = raw instanceof Date ? raw.toISOString() : String(raw ?? "").trim();
	const at = new Date(text);
	if (!text || Number.isNaN(at.getTime())) return { ok: false, reason: "invalid" };
	const delta = at.getTime() - now;
	if (delta < -SCHEDULE_PAST_TOLERANCE_MS) return { ok: false, reason: "past" };
	return { ok: true, at, delayMs: Math.max(0, delta) };
}

export type SchedulePreset = {
	key: "in1h" | "in2h" | "tomorrow8" | "monday8";
	labelEn: string;
	labelFr: string;
	date: Date;
};

const pad = (n: number) => String(n).padStart(2, "0");

// Date civile (AAAA-MM-JJ) decalee de n jours, par calcul UTC : insensible aux changements d'heure.
function shiftYmd(ymd: string, days: number) {
	const [y, m, d] = ymd.split("-").map(Number);
	const u = new Date(Date.UTC(y, m - 1, d + days));
	return {
		ymd: `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`,
		weekday: u.getUTCDay(), // 0 = dimanche
	};
}

// Dans 1 h, dans 2 h, demain 8 h, lundi 8 h (le lundi suivant, jamais aujourd'hui) ; fuseau tz.
export function schedulePresets(now: Date, tz: string): SchedulePreset[] {
	const today = dayjsExtended(now).tz(tz).format("YYYY-MM-DD");
	const at8 = (ymd: string) => dayjsExtended.tz(`${ymd} 08:00`, tz).toDate();
	const minute = (h: number) => new Date(Math.floor(now.getTime() / 60_000) * 60_000 + h * 3600_000);
	const daysToMonday = ((8 - shiftYmd(today, 0).weekday) % 7) || 7;
	return [
		{ key: "in1h", labelEn: "In 1 hour", labelFr: "Dans 1 h", date: minute(1) },
		{ key: "in2h", labelEn: "In 2 hours", labelFr: "Dans 2 h", date: minute(2) },
		{ key: "tomorrow8", labelEn: "Tomorrow 08:00", labelFr: "Demain 8 h", date: at8(shiftYmd(today, 1).ymd) },
		{ key: "monday8", labelEn: "Monday 08:00", labelFr: "Lundi 8 h", date: at8(shiftYmd(today, daysToMonday).ymd) },
	];
}

// « jeu. 13/11 à 08:00 » (fr) / « Thu 13/11 08:00 » (en), 24 h ; l'annee seulement si elle change.
export function formatScheduledWhen(
	at: Date | string,
	lang: "fr" | "en" = "fr",
	tz?: string,
	now: Date = new Date(),
) {
	const d = at instanceof Date ? at : new Date(at);
	const parts = (date: Date, opts: Intl.DateTimeFormatOptions) =>
		Object.fromEntries(
			new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { timeZone: tz, hourCycle: "h23", ...opts })
				.formatToParts(date)
				.map((p) => [p.type, p.value]),
		) as Record<string, string>;
	const p = parts(d, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
	const sameYear = p.year === parts(now, { year: "numeric" }).year;
	const day = `${p.day}/${p.month}${sameYear ? "" : `/${p.year}`}`;
	const weekday = lang === "fr" ? p.weekday : p.weekday.replace(/\.$/, "");
	return lang === "fr"
		? `${weekday} ${day} à ${p.hour}:${p.minute}`
		: `${weekday} ${day} ${p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------
// Saisie libre d'un moment (« demain 9h30 », « lundi 8h », « dans 2h », « 13/11 10h »).

export type ScheduleParse =
	| { ok: true; at: Date }
	| { ok: false; reason: "empty" | "unknown" | "past" };

// Minuscules, sans accents, apostrophes droites, sans point ni tiret, espaces simples.
function normalizeText(text: string) {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[\u2019\u2018`]/g, "'")
		.replace(/[.\-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const MONTHS: Record<string, number> = {
	janvier: 1, janv: 1, jan: 1, fevrier: 2, fevr: 2, fev: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6,
	juillet: 7, juil: 7, aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11,
	decembre: 12, dec: 12,
};
const WEEKDAYS: Record<string, number> = {
	dimanche: 0, dim: 0, lundi: 1, lun: 1, mardi: 2, mar: 2, mercredi: 3, mer: 3, jeudi: 4, jeu: 4,
	vendredi: 5, ven: 5, samedi: 6, sam: 6,
};
const alt = (o: Record<string, number>) => Object.keys(o).sort((a, b) => b.length - a.length).join("|");

const hm = (h: number, m: number) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? { h, m } : null);

// Heure d'une saisie : 9, 9h, 9h30, 9 h 30, 09:30, 930, midi, minuit ; null sinon.
export function parseTimeText(text: string): { h: number; m: number } | null {
	const s = normalizeText(text);
	let r: RegExpMatchArray | null;
	if (s === "midi") return { h: 12, m: 0 };
	if (s === "minuit") return { h: 0, m: 0 };
	if ((r = s.match(/^(\d{1,2}) ?h ?(\d{2})?$/))) return hm(+r[1], r[2] ? +r[2] : 0);
	if ((r = s.match(/^(\d{1,2}):(\d{2})$/))) return hm(+r[1], +r[2]);
	if ((r = s.match(/^(\d{1,2})(\d{2})$/))) return hm(+r[1], +r[2]);
	if ((r = s.match(/^(\d{1,2})$/))) return hm(+r[1], 0);
	return null;
}

// Comprend une saisie en francais, dans le fuseau tz (les changements d'heure sont ceux du fuseau) :
// - « dans 2h », « dans 30 min », « dans 1h30 » : une duree reelle ; « dans 3 jours » : ce jour a 8 h ;
// - jour : demain, apres-demain, aujourd'hui / auj, jour de la semaine (le prochain, strictement
//   apres aujourd'hui), 13/11, 13/11/2026, 13/11/26, 13 novembre ; sans heure : 8 h ;
// - heure seule : aujourd'hui si elle est a plus d'une minute, sinon demain.
// Une date sans annee deja passee est celle de l'an prochain ; un instant passe de plus d'une minute
// est refuse (meme regle que validateScheduledAt).
export function parseScheduleText(text: string, now: Date, tz: string): ScheduleParse {
	let s = normalizeText(text);
	if (!s) return { ok: false, reason: "empty" };
	const unknown = { ok: false, reason: "unknown" } as const;
	const today = dayjsExtended(now).tz(tz).format("YYYY-MM-DD");
	const civil = (ymd: string, t: { h: number; m: number }) =>
		dayjsExtended.tz(`${ymd} ${pad(t.h)}:${pad(t.m)}`, tz).toDate();
	const done = (at: Date): ScheduleParse =>
		at.getTime() < now.getTime() - SCHEDULE_PAST_TOLERANCE_MS
			? { ok: false, reason: "past" }
			: { ok: true, at };
	const eat = (re: RegExp) => {
		const m = s.match(re);
		if (m) s = `${s.slice(0, m.index)} ${s.slice((m.index ?? 0) + m[0].length)}`.replace(/\s+/g, " ").trim();
		return m;
	};

	// Duree : « dans 2h », « dans 2 h 30 », « dans 30 min », « dans 3 jours », « dans 1 semaine ».
	let m: RegExpMatchArray | null;
	if ((m = s.match(/^dans (?:(\d{1,3}) ?(?:h|heures?)(?: ?(\d{1,3}))?(?: ?(?:min|mn|minutes?))?|(\d{1,4}) ?(?:min|mn|minutes?)|(\d{1,3}) ?(?:j|jours?)|(\d{1,2}) ?(?:sem|semaines?))$/))) {
		const minute = Math.floor(now.getTime() / 60_000) * 60_000;
		if (m[1] !== undefined) return { ok: true, at: new Date(minute + (+m[1] * 60 + (m[2] ? +m[2] : 0)) * 60_000) };
		if (m[3] !== undefined) return { ok: true, at: new Date(minute + +m[3] * 60_000) };
		const days = m[4] !== undefined ? +m[4] : +m[5] * 7;
		return done(civil(shiftYmd(today, days).ymd, { h: 8, m: 0 }));
	}

	// Jour : date numerique, date en lettres, mot (apres-demain, demain, aujourd'hui), jour de la semaine.
	let date: { d: number; mo: number; y: number | null } | null = null;
	let offset: number | null = null; // jours depuis aujourd'hui
	let weekday: number | null = null;
	if ((m = eat(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/))) {
		date = { d: +m[1], mo: +m[2], y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null };
	} else if ((m = eat(new RegExp(`\\b(\\d{1,2})(?:er)? ?(${alt(MONTHS)})\\b(?: (20\\d{2})\\b)?`)))) {
		date = { d: +m[1], mo: MONTHS[m[2]], y: m[3] ? +m[3] : null };
	} else if (eat(/\bapres demain\b/)) offset = 2;
	else if (eat(/\bdemain\b/)) offset = 1;
	else if (eat(/\b(?:aujourd'?hui|auj)\b/)) offset = 0;
	else if ((m = eat(new RegExp(`\\b(${alt(WEEKDAYS)})\\b`)))) weekday = WEEKDAYS[m[1]];
	// Un jour de la semaine donne avec une date est ignore (la date fait foi).
	if (date) eat(new RegExp(`\\b(${alt(WEEKDAYS)})\\b`));

	// Heure : midi, minuit, 8h, 8h30, 8 h 30, 08:30, 830, 9.
	let time: { h: number; m: number } | null = null;
	let timeText: string | null = null;
	if ((m = eat(/\b(midi|minuit)\b/))) timeText = m[1];
	else if ((m = eat(/\b(\d{1,2} ?h(?: ?\d{2})?)\b/)) || (m = eat(/\b(\d{1,2}:\d{2})\b/))) timeText = m[1];
	else if ((m = eat(/\b(\d{3,4})\b/)) || (m = eat(/\b(\d{1,2})\b/))) timeText = m[1];
	if (timeText !== null && !(time = parseTimeText(timeText))) return unknown;

	// Mots de liaison tolerés ; tout autre reste est incompris.
	s = s.replace(/\b(a|le|au|vers|pour|ce|sur|de|du|@)\b/g, " ").replace(/\s+/g, " ").trim();
	if (s) return unknown;
	if (!date && offset === null && weekday === null && !time) return unknown;

	if (date) {
		const valid = (y: number) => {
			const u = new Date(Date.UTC(y, date!.mo - 1, date!.d));
			return date!.mo >= 1 && date!.mo <= 12 && u.getUTCMonth() === date!.mo - 1 && u.getUTCDate() === date!.d;
		};
		const ymdOf = (y: number) => `${y}-${pad(date!.mo)}-${pad(date!.d)}`;
		let y = date.y ?? Number(today.slice(0, 4));
		if (!valid(y)) return unknown;
		if (date.y === null && ymdOf(y) < today) {
			y += 1; // deja passee cette annee : l'an prochain
			if (!valid(y)) return unknown;
		}
		return done(civil(ymdOf(y), time ?? { h: 8, m: 0 }));
	}
	if (weekday !== null) {
		const wd = shiftYmd(today, 0).weekday;
		return done(civil(shiftYmd(today, ((weekday - wd + 6) % 7) + 1).ymd, time ?? { h: 8, m: 0 }));
	}
	if (offset !== null) return done(civil(shiftYmd(today, offset).ymd, time ?? { h: 8, m: 0 }));
	const todayAt = civil(today, time!);
	if (todayAt.getTime() - now.getTime() > SCHEDULE_PAST_TOLERANCE_MS) return { ok: true, at: todayAt };
	return { ok: true, at: civil(shiftYmd(today, 1).ymd, time!) };
}

// ---------------------------------------------------------------------------
// Job BullMQ d'un envoi programme (file send-mail), construit au meme endroit pour l'editeur
// web, le MCP et la reprise au demarrage du worker.

export const SCHEDULED_JOB = "send-scheduled-draft";

type ScheduledRow = {
	id: string;
	identityId: string | null;
	scheduledAt: Date | string | null;
	payload: Record<string, any>;
};

// jobId = id de la ligne draft_messages : rejouer l'ajout est sans effet (reprise). identityId
// sert au controle d'acces de « Annuler » / « Envoyer maintenant » ; imapDraftId est le
// brouillon (ligne messages) qui porte la marque pendingSend.
export function scheduledJobOf(row: ScheduledRow, now: number = Date.now()) {
	const delay = Math.max(0, new Date(row.scheduledAt ?? now).getTime() - now);
	return {
		name: SCHEDULED_JOB,
		data: {
			draftMessageId: row.id,
			identityId: row.identityId ?? String(row.payload?.identityId ?? ""),
			imapDraftId: (row.payload?.draftMessageId as string | undefined) ?? null,
		},
		opts: { jobId: row.id, delay },
	};
}

// Marque « envoi en cours / programme » du brouillon IMAP (meta.draft.pendingSend).
export function scheduledPendingSend(row: { id: string; scheduledAt: Date | string | null }) {
	return { jobId: row.id, sendAt: new Date(row.scheduledAt ?? Date.now()).toISOString() };
}

// Brouillon IMAP d'un job d'envoi : pour « send-and-reconcile », draftMessageId est le brouillon ;
// pour un job programme, draftMessageId est la ligne draft_messages et imapDraftId le brouillon.
export function imapDraftIdOfJob(name: string | undefined, data: Record<string, any> | null | undefined) {
	if (name === SCHEDULED_JOB) return String(data?.imapDraftId ?? "");
	if (name === "send-and-reconcile") return String(data?.draftMessageId ?? "");
	return "";
}

// Reprise au demarrage du worker : que faire d'une ligne « scheduled » selon l'etat de son job
// BullMQ (null = pas de job). Un job en echec ou termine n'est jamais rejoue (double envoi) :
// echec -> la ligne passe en « failed » avec l'erreur sur le brouillon ; termine -> signale.
export function rehydrateActionOf(jobState: string | null): "add" | "keep" | "fail" | "skip" {
	if (jobState === null) return "add";
	if (jobState === "failed") return "fail";
	if (jobState === "completed") return "skip";
	return "keep";
}
