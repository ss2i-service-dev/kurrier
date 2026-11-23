// Schedule send (pure part, no database or Redis; see apps/web/test/schedule-send.ts): menu
// presets, check of the requested time, "scheduled for" formatting and free-text input.
import { dayjsExtended } from "./day-js-extended";

// A time more than one minute in the past is refused; below that, the send leaves right away.
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
	label: string;
	date: Date;
};

const pad = (n: number) => String(n).padStart(2, "0");

// Civil date (YYYY-MM-DD) shifted by n days, computed in UTC: immune to clock changes.
function shiftYmd(ymd: string, days: number) {
	const [y, m, d] = ymd.split("-").map(Number);
	const u = new Date(Date.UTC(y, m - 1, d + days));
	return {
		ymd: `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`,
		weekday: u.getUTCDay(), // 0 = Sunday
	};
}

// In 1 hour, in 2 hours, tomorrow 8:00, Monday 8:00 (the next Monday, never today), in time
// zone tz. hour24: the "24-hour time" option (pref24HourTime), 12-hour clock otherwise.
export function schedulePresets(now: Date, tz: string, hour24 = false): SchedulePreset[] {
	const today = dayjsExtended(now).tz(tz).format("YYYY-MM-DD");
	const at8 = (ymd: string) => dayjsExtended.tz(`${ymd} 08:00`, tz).toDate();
	const minute = (h: number) => new Date(Math.floor(now.getTime() / 60_000) * 60_000 + h * 3600_000);
	const daysToMonday = ((8 - shiftYmd(today, 0).weekday) % 7) || 7;
	const eight = hour24 ? "08:00" : "8:00 AM";
	return [
		{ key: "in1h", label: "In 1 hour", date: minute(1) },
		{ key: "in2h", label: "In 2 hours", date: minute(2) },
		{ key: "tomorrow8", label: `Tomorrow ${eight}`, date: at8(shiftYmd(today, 1).ymd) },
		{ key: "monday8", label: `Monday ${eight}`, date: at8(shiftYmd(today, daysToMonday).ymd) },
	];
}

// "Fri, Nov 13, 8:00 AM" (12-hour clock, en-US) or "Fri 13 Nov, 08:00" (24-hour time, en-GB):
// the day, then the time in the format of the "24-hour time" option, like the times of an
// invitation (lib/hour-format.ts); the year only when it differs. locale: the browser's by default.
export function formatScheduledWhen(
	at: Date | string,
	tz?: string,
	now: Date = new Date(),
	hour24 = false,
	locale?: string,
) {
	const d = at instanceof Date ? at : new Date(at);
	const year = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(date);
	return new Intl.DateTimeFormat(locale, {
		timeZone: tz,
		weekday: "short",
		day: "numeric",
		month: "short",
		...(year(d) === year(now) ? {} : { year: "numeric" }),
		...(hour24 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "numeric", minute: "2-digit" }),
	}).format(d);
}

// ---------------------------------------------------------------------------
// Free-text input of a moment ("tomorrow 9:30", "monday 8am", "in 2h", "nov 13 10am").

export type ScheduleParse =
	| { ok: true; at: Date }
	| { ok: false; reason: "empty" | "unknown" | "past" };

// Lower case, no accents, straight apostrophes, no dots or commas, "-" kept only inside an ISO
// date, single spaces.
function normalizeText(text: string) {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[\u2019\u2018`]/g, "'")
		.replace(/[.,]/g, " ")
		.replace(/(?<!\d)-|-(?!\d)/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const MONTHS: Record<string, number> = {
	january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
	july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
	november: 11, nov: 11, december: 12, dec: 12,
};
const WEEKDAYS: Record<string, number> = {
	sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
	thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const alt = (o: Record<string, number>) => Object.keys(o).sort((a, b) => b.length - a.length).join("|");

const hm = (h: number, m: number) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? { h, m } : null);

// Time of an input: 9, 9am, 9 pm, 9:30, 9:30am, 09:30, 21:30, 930, noon, midnight; null otherwise.
// With am/pm the hour goes from 1 to 12 (12am = midnight, 12pm = noon).
export function parseTimeText(text: string): { h: number; m: number } | null {
	const s = normalizeText(text);
	let r: RegExpMatchArray | null;
	if (s === "noon") return { h: 12, m: 0 };
	if (s === "midnight") return { h: 0, m: 0 };
	if ((r = s.match(/^(\d{1,2})(?::(\d{2}))? ?(am|pm)$/))) {
		const h = +r[1];
		if (h < 1 || h > 12) return null;
		return hm((h % 12) + (r[3] === "pm" ? 12 : 0), r[2] ? +r[2] : 0);
	}
	if ((r = s.match(/^(\d{1,2}):(\d{2})$/))) return hm(+r[1], +r[2]);
	if ((r = s.match(/^(\d{1,2})(\d{2})$/))) return hm(+r[1], +r[2]);
	if ((r = s.match(/^(\d{1,2})$/))) return hm(+r[1], 0);
	return null;
}

// Reads an English input, in time zone tz (clock changes are those of the zone):
// - "in 2h", "in 30 min", "in 1h30": a real duration; "in 3 days", "in 1 week": that day at 8:00;
// - day: tomorrow, day after tomorrow, today, a weekday (the next one, strictly after today),
//   nov 13, november 13, 13 nov, 13th november, nov 13 2026, 2026-11-13; without a time: 8:00;
// - time alone: today if it is more than one minute ahead, tomorrow otherwise.
// A date without a year that has already passed is next year's; a moment more than one minute in
// the past is refused (same rule as validateScheduledAt).
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

	// Duration: "in 2h", "in 2 h 30", "in 2 hours 30 min", "in 30 min", "in 3 days", "in 1 week".
	let m: RegExpMatchArray | null;
	if ((m = s.match(/^in (?:(\d{1,3}) ?(?:h|hrs?|hours?)(?: ?(\d{1,3}))?(?: ?(?:m|mins?|minutes?))?|(\d{1,4}) ?(?:m|mins?|minutes?)|(\d{1,3}) ?(?:d|days?)|(\d{1,2}) ?(?:w|wks?|weeks?))$/))) {
		const minute = Math.floor(now.getTime() / 60_000) * 60_000;
		if (m[1] !== undefined) return { ok: true, at: new Date(minute + (+m[1] * 60 + (m[2] ? +m[2] : 0)) * 60_000) };
		if (m[3] !== undefined) return { ok: true, at: new Date(minute + +m[3] * 60_000) };
		const days = m[4] !== undefined ? +m[4] : +m[5] * 7;
		return done(civil(shiftYmd(today, days).ymd, { h: 8, m: 0 }));
	}

	// Day: ISO date, date in words, word (day after tomorrow, tomorrow, today), weekday.
	const months = alt(MONTHS);
	let date: { d: number; mo: number; y: number | null } | null = null;
	let offset: number | null = null; // days from today
	let weekday: number | null = null;
	if ((m = eat(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
		date = { d: +m[3], mo: +m[2], y: +m[1] };
	} else if ((m = eat(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${months})\\b(?: (20\\d{2})\\b)?`)))) {
		// Day first ("13 nov 10:30"), tried before "nov 13" so that the time is not read as the day.
		date = { d: +m[1], mo: MONTHS[m[2]], y: m[3] ? +m[3] : null };
	} else if ((m = eat(new RegExp(`\\b(${months}) (\\d{1,2})(?:st|nd|rd|th)?\\b(?: (20\\d{2})\\b)?`)))) {
		date = { d: +m[2], mo: MONTHS[m[1]], y: m[3] ? +m[3] : null };
	} else if (eat(/\b(?:the )?day after tomorrow\b/)) offset = 2;
	else if (eat(/\b(?:tomorrow|tmrw|tmr)\b/)) offset = 1;
	else if (eat(/\btoday\b/)) offset = 0;
	else if ((m = eat(new RegExp(`\\b(${alt(WEEKDAYS)})\\b`)))) weekday = WEEKDAYS[m[1]];
	// A weekday given with a date is ignored (the date prevails).
	if (date) eat(new RegExp(`\\b(${alt(WEEKDAYS)})\\b`));

	// Time: noon, midnight, 8am, 8:30 pm, 08:30, 830, 9.
	let time: { h: number; m: number } | null = null;
	let timeText: string | null = null;
	if ((m = eat(/\b(noon|midnight)\b/))) timeText = m[1];
	else if ((m = eat(/\b(\d{1,2}(?::\d{2})? ?(?:am|pm))\b/)) || (m = eat(/\b(\d{1,2}:\d{2})\b/))) timeText = m[1];
	else if ((m = eat(/\b(\d{3,4})\b/)) || (m = eat(/\b(\d{1,2})\b/))) timeText = m[1];
	if (timeText !== null && !(time = parseTimeText(timeText))) return unknown;

	// Linking words are tolerated; anything else left is not understood.
	s = s.replace(/(?:^|\s)(?:at|on|the|next|this|by|around|for|@)(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
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
			y += 1; // already passed this year: next year
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
// BullMQ job of a scheduled send (send-mail queue), built in one place for the web editor, the
// drafts service and the worker's startup recovery.

export const SCHEDULED_JOB = "send-scheduled-draft";

type ScheduledRow = {
	id: string;
	identityId: string | null;
	scheduledAt: Date | string | null;
	payload: Record<string, any>;
};

// jobId = id of the draft_messages row: adding it again has no effect (recovery). identityId is
// used by the access check of "Cancel" / "Send now"; imapDraftId is the draft (messages row)
// that carries the pendingSend mark.
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

// "Sending / scheduled" mark of the IMAP draft (meta.draft.pendingSend).
export function scheduledPendingSend(row: { id: string; scheduledAt: Date | string | null }) {
	return { jobId: row.id, sendAt: new Date(row.scheduledAt ?? Date.now()).toISOString() };
}

// IMAP draft of a send job: for "send-and-reconcile", draftMessageId is the draft; for a
// scheduled job, draftMessageId is the draft_messages row and imapDraftId the draft.
export function imapDraftIdOfJob(name: string | undefined, data: Record<string, any> | null | undefined) {
	if (name === SCHEDULED_JOB) return String(data?.imapDraftId ?? "");
	if (name === "send-and-reconcile") return String(data?.draftMessageId ?? "");
	return "";
}

// Worker startup recovery: what to do with a "scheduled" row given the state of its BullMQ job
// (null = no job). A failed or completed job is never replayed (double send): failed -> the row
// becomes "failed" with the error on the draft; completed -> reported.
export function rehydrateActionOf(jobState: string | null): "add" | "keep" | "fail" | "skip" {
	if (jobState === null) return "add";
	if (jobState === "failed") return "fail";
	if (jobState === "completed") return "skip";
	return "keep";
}
