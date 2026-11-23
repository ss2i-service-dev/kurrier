// Schedule send: write a message now and have it leave later, with the option to cancel or
// change it before. Presets ("Monday 8:00 AM" used to show the Sunday), time check, "scheduled"
// phase of the badge and the banner, free-text input: pure parts, no database nor Redis.
// From the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/schedule-send.ts
import assert from "node:assert/strict";
import {
	formatScheduledWhen,
	parseScheduleText,
	parseTimeText,
	schedulePresets,
	validateScheduledAt,
} from "../../../packages/common/src/schedule-send";
import {
	SCHEDULED_AFTER_MS,
	sendLabel,
	sendPhaseOf,
	sendTrackingOf,
} from "../lib/send-phase";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const TZ = "Europe/Paris";
// Thursday 2026-11-12 10:00 in Paris (UTC+1) = 09:00 UTC.
const THU = new Date("2026-11-12T09:00:00Z");
// "2026-11-13 08:00": civil day and 24-hour time of a moment in time zone tz.
const local = (d: Date, tz = TZ) => {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
			.formatToParts(d)
			.map((x) => [x.type, x.value]),
	) as Record<string, string>;
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
// Intl puts a narrow no-break space before AM/PM: compared as a plain space.
const plain = (s: string) => s.replace(/\s/g, " ");

test("presets on Thursday 11/12 10:00: +1 h, +2 h, tomorrow 8:00, Monday 8:00", () => {
	const p = schedulePresets(THU, TZ);
	assert.deepEqual(p.map((x) => x.key), ["in1h", "in2h", "tomorrow8", "monday8"]);
	assert.equal(local(p[0].date), "2026-11-12 11:00");
	assert.equal(local(p[1].date), "2026-11-12 12:00");
	assert.equal(local(p[2].date), "2026-11-13 08:00");
	assert.equal(local(p[3].date), "2026-11-16 08:00");
	assert.equal(p[0].label, "In 1 hour");
	assert.equal(p[1].label, "In 2 hours");
	assert.equal(p[2].label, "Tomorrow 8:00 AM");
	assert.equal(p[3].label, "Monday 8:00 AM");
});

test("preset labels follow the 24-hour time option", () => {
	const p = schedulePresets(THU, TZ, true);
	assert.equal(p[2].label, "Tomorrow 08:00");
	assert.equal(p[3].label, "Monday 08:00");
	assert.equal(local(p[3].date), "2026-11-16 08:00");
});

test("on a Monday, \"Monday 8:00\" is the next Monday, never today", () => {
	const mon = new Date("2026-11-16T07:00:00Z"); // Monday 08:00 in Paris
	assert.equal(local(schedulePresets(mon, TZ)[3].date), "2026-11-23 08:00");
	const monEarly = new Date("2026-11-16T05:00:00Z"); // Monday 06:00: still the next one
	assert.equal(local(schedulePresets(monEarly, TZ)[3].date), "2026-11-23 08:00");
});

test("Sunday, Saturday: the next Monday", () => {
	const sun = new Date("2026-11-15T10:00:00Z");
	assert.equal(local(schedulePresets(sun, TZ)[3].date), "2026-11-16 08:00");
	const sat = new Date("2026-11-14T10:00:00Z");
	assert.equal(local(schedulePresets(sat, TZ)[3].date), "2026-11-16 08:00");
});

test("the local date counts, not the UTC one (00:30 in Paris on 11/13 = 23:30 UTC on 11/12)", () => {
	const late = new Date("2026-11-12T23:30:00Z"); // Friday 11/13 00:30 in Paris
	const p = schedulePresets(late, TZ);
	assert.equal(local(p[2].date), "2026-11-14 08:00");
	assert.equal(local(p[3].date), "2026-11-16 08:00");
});

test("autumn clock change (Monday 10/26 is UTC+1): 8:00 stays 8:00", () => {
	const fri = new Date("2026-10-23T10:00:00Z");
	assert.equal(local(schedulePresets(fri, TZ)[3].date), "2026-10-26 08:00");
	const sat = new Date("2026-10-24T10:00:00Z"); // tomorrow = Sunday 10/25, day of the change
	assert.equal(local(schedulePresets(sat, TZ)[2].date), "2026-10-25 08:00");
});

test("other time zone", () => {
	const p = schedulePresets(THU, "America/Montreal"); // 04:00 in Montreal
	assert.equal(local(p[2].date, "America/Montreal"), "2026-11-13 08:00");
	assert.equal(local(p[0].date, "America/Montreal"), "2026-11-12 05:00");
});

test("formatting: weekday, then the time in the format of the 24-hour time option", () => {
	const at = new Date("2026-11-13T07:00:00Z"); // Friday 11/13 08:00 in Paris
	assert.equal(plain(formatScheduledWhen(at, TZ, THU, false, "en-US")), "Fri, Nov 13, 8:00 AM");
	assert.equal(plain(formatScheduledWhen(at, TZ, THU, true, "en-US")), "Fri, Nov 13, 08:00");
	assert.equal(plain(formatScheduledWhen(at, TZ, THU, true, "en-GB")), "Fri 13 Nov, 08:00");
	const late = new Date("2026-11-12T22:30:00Z");
	assert.equal(plain(formatScheduledWhen(late, TZ, THU, false, "en-US")), "Thu, Nov 12, 11:30 PM");
	assert.equal(plain(formatScheduledWhen(late, TZ, THU, true, "en-US")), "Thu, Nov 12, 23:30");
});

test("formatting: the year shows only when it differs", () => {
	const next = new Date("2027-01-04T07:00:00Z");
	assert.equal(plain(formatScheduledWhen(next, TZ, THU, false, "en-US")), "Mon, Jan 4, 2027, 8:00 AM");
});

test("time past by more than a minute: refused; by less: tolerated, leaves right away", () => {
	const past = validateScheduledAt("2026-11-12T08:58:00Z", THU.getTime());
	assert.equal(past.ok, false);
	assert.equal((past as any).reason, "past");
	const recent = validateScheduledAt("2026-11-12T08:59:30Z", THU.getTime());
	assert.equal(recent.ok, true);
	assert.equal((recent as any).delayMs, 0);
});

test("valid time: delay in ms; invalid or empty text: refused", () => {
	const ok = validateScheduledAt("2026-11-12T11:00:00+02:00", THU.getTime());
	assert.equal(ok.ok, true);
	assert.equal((ok as any).delayMs, 0); // 11:00+02:00 = 09:00Z = now
	const two = validateScheduledAt("2026-11-12T12:00:00+01:00", THU.getTime());
	assert.equal((two as any).delayMs, 2 * 3600_000);
	assert.equal((two as any).at.toISOString(), "2026-11-12T11:00:00.000Z");
	for (const bad of ["", "not a date", "2026-13-45"]) {
		const r = validateScheduledAt(bad, THU.getTime());
		assert.equal(r.ok, false, bad);
		assert.equal((r as any).reason, "invalid", bad);
	}
});

test("phases: countdown, sending, scheduled beyond 2 minutes, unknown", () => {
	const now = THU.getTime();
	const at = (ms: number) => new Date(now + ms).toISOString();
	assert.equal(SCHEDULED_AFTER_MS, 2 * 60_000);
	assert.equal(sendPhaseOf(at(30_000), now), "countdown");
	assert.equal(sendPhaseOf(at(SCHEDULED_AFTER_MS), now), "countdown");
	assert.equal(sendPhaseOf(at(SCHEDULED_AFTER_MS + 1), now), "scheduled");
	assert.equal(sendPhaseOf(at(2 * 3600_000), now), "scheduled");
	assert.equal(sendPhaseOf(at(-1000), now), "sending");
	assert.equal(sendPhaseOf(at(-4 * 60_000), now), "unknown");
	assert.equal(sendPhaseOf("anything", now), "unknown");
});

test("labels: countdown, scheduled (12-hour and 24-hour time), sending", () => {
	const now = THU.getTime();
	const at = (ms: number) => new Date(now + ms).toISOString();
	assert.equal(sendLabel(at(30_000), now, TZ), "Sending in 30s");
	assert.equal(sendLabel(at(-1000), now, TZ), "Sending…");
	// Thursday 11/19 at 08:00 in Paris = 07:00 UTC
	assert.equal(plain(sendLabel("2026-11-19T07:00:00.000Z", now, TZ, false, "en-US")), "Scheduled for Thu, Nov 19, 8:00 AM");
	assert.equal(plain(sendLabel("2026-11-19T07:00:00.000Z", now, TZ, true, "en-GB")), "Scheduled for Thu 19 Nov, 08:00");
	assert.ok(!/ \d{3,}s/.test(sendLabel(at(7200_000), now, TZ)), "never \"Sending in 7200s\"");
});

test("label before mount (time zone unknown): no time, so no render mismatch", () => {
	const now = THU.getTime();
	assert.equal(sendLabel("2026-11-19T07:00:00.000Z", now, null), "Scheduled");
});

test("tracking: scheduled = no clock nor refresh, a single wake-up when the countdown starts", () => {
	const now = THU.getTime();
	const at = (ms: number) => new Date(now + ms).toISOString();
	const t = sendTrackingOf([at(3 * 3600_000)], now);
	assert.equal(t.fast, false);
	assert.equal(t.wakeAt, now + 3 * 3600_000 - SCHEDULED_AFTER_MS);
	// several: the wake-up is the nearest, and a running countdown stays closely tracked
	const mixed = sendTrackingOf([at(5 * 3600_000), at(3600_000), at(20_000), null, undefined], now);
	assert.equal(mixed.fast, true);
	assert.equal(mixed.wakeAt, now + 3600_000 - SCHEDULED_AFTER_MS);
	assert.deepEqual(sendTrackingOf([at(30_000)], now), { fast: true, wakeAt: null });
	assert.deepEqual(sendTrackingOf([at(-10_000)], now), { fast: true, wakeAt: null });
	assert.deepEqual(sendTrackingOf([at(-10 * 60_000), "anything"], now), { fast: false, wakeAt: null });
	assert.deepEqual(sendTrackingOf([], now), { fast: false, wakeAt: null });
});

// ---------------------------------------------------------------------------
// Free-text input ("tomorrow 9:30am", "monday 8am", "in 2h", "nov 13 10am").
// Thursday 2026-11-12 12:21 in Paris (UTC+1) = 11:21 UTC.
const NOW = new Date("2026-11-12T11:21:00Z");
const at = (text: string, now: Date = NOW) => {
	const r = parseScheduleText(text, now, TZ);
	assert.equal(r.ok, true, `"${text}" should be understood: ${JSON.stringify(r)}`);
	return local((r as { ok: true; at: Date }).at);
};
const refused = (text: string, now: Date = NOW) => {
	const r = parseScheduleText(text, now, TZ);
	assert.equal(r.ok, false, `"${text}" should be refused: ${JSON.stringify(r)}`);
	return (r as { ok: false; reason: string }).reason;
};

test("time alone: today if it is more than a minute ahead, tomorrow otherwise", () => {
	assert.equal(at("9am"), "2026-11-13 09:00");
	assert.equal(at("2pm"), "2026-11-12 14:00");
	assert.equal(at("14:00"), "2026-11-12 14:00");
	assert.equal(at("noon"), "2026-11-13 12:00");
	assert.equal(at("midnight"), "2026-11-13 00:00");
	assert.equal(at("12:22"), "2026-11-13 12:22"); // exactly 1 min ahead: not "more than a minute"
	assert.equal(at("12:23"), "2026-11-12 12:23");
});

test("time forms: 2:30pm, 2:30 pm, 2:30 PM, 14:30, 1430, 9", () => {
	for (const t of ["2:30pm", "2:30 pm", "2:30 PM", "14:30", "1430"]) assert.equal(at(t), "2026-11-12 14:30", t);
	assert.equal(at("830"), "2026-11-13 08:30");
	assert.equal(at("8:30"), "2026-11-13 08:30");
	assert.equal(at("8:30am"), "2026-11-13 08:30");
	assert.equal(at("9"), "2026-11-13 09:00");
	assert.equal(at("12am"), "2026-11-13 00:00");
	assert.equal(at("12pm"), "2026-11-13 12:00");
});

test("tomorrow, day after tomorrow, today, with or without a time", () => {
	assert.equal(at("tomorrow"), "2026-11-13 08:00");
	assert.equal(at("tomorrow 9:30am"), "2026-11-13 09:30");
	assert.equal(at("tomorrow at 9:30"), "2026-11-13 09:30");
	assert.equal(at("tmrw 9am"), "2026-11-13 09:00");
	assert.equal(at("day after tomorrow"), "2026-11-14 08:00");
	assert.equal(at("the day after tomorrow 10am"), "2026-11-14 10:00");
	assert.equal(at("today 2pm"), "2026-11-12 14:00");
	assert.equal(at("today at 15:00"), "2026-11-12 15:00");
	assert.equal(refused("today 9am"), "past");
	assert.equal(refused("today"), "past"); // 8:00 has passed
});

test("weekdays: the next occurrence, strictly after today", () => {
	assert.equal(at("monday 8am"), "2026-11-16 08:00");
	assert.equal(at("mon"), "2026-11-16 08:00");
	assert.equal(at("mon."), "2026-11-16 08:00");
	assert.equal(at("Monday"), "2026-11-16 08:00");
	assert.equal(at("next monday"), "2026-11-16 08:00");
	assert.equal(at("friday 9am"), "2026-11-13 09:00");
	assert.equal(at("thursday"), "2026-11-19 08:00"); // today is Thursday: next week
	assert.equal(at("thu 10am"), "2026-11-19 10:00");
	assert.equal(at("sunday 6pm"), "2026-11-15 18:00");
	const mon = new Date("2026-11-16T10:00:00Z");
	assert.equal(at("monday", mon), "2026-11-23 08:00");
});

test("in N: hours, minutes, days, weeks", () => {
	assert.equal(at("in 2h"), "2026-11-12 14:21");
	assert.equal(at("in 2 hours"), "2026-11-12 14:21");
	assert.equal(at("in 30 min"), "2026-11-12 12:51");
	assert.equal(at("in 1h30"), "2026-11-12 13:51");
	assert.equal(at("in 3 days"), "2026-11-15 08:00");
	assert.equal(at("in 1 week"), "2026-11-19 08:00");
	assert.equal(at("In  45  minutes"), "2026-11-12 13:06");
});

test("dates: nov 13, november 13, 13 nov, 13th of november, ISO, with or without a time", () => {
	assert.equal(at("nov 13 10am"), "2026-11-13 10:00");
	assert.equal(at("nov 13"), "2026-11-13 08:00");
	assert.equal(at("Nov 13 9:30 AM"), "2026-11-13 09:30");
	assert.equal(at("november 13 2026 9am"), "2026-11-13 09:00");
	assert.equal(at("13 nov 10:30"), "2026-11-13 10:30");
	assert.equal(at("13th of november"), "2026-11-13 08:00");
	assert.equal(at("dec 1st 9am"), "2026-12-01 09:00");
	assert.equal(at("on the 20th of nov at 7am"), "2026-11-20 07:00");
	assert.equal(at("nov 13 2027 9am"), "2027-11-13 09:00");
	assert.equal(at("2026-11-13 09:30"), "2026-11-13 09:30");
	assert.equal(at("fri nov 13 9am"), "2026-11-13 09:00");
});

test("a past date without a year is next year's; with a year, it is refused", () => {
	assert.equal(at("jan 1 9am"), "2027-01-01 09:00");
	assert.equal(at("nov 11"), "2027-11-11 08:00");
	assert.equal(refused("nov 12 2025 9am"), "past");
	assert.equal(refused("nov 12 9am"), "past"); // today, time passed: not next year
	assert.equal(at("nov 12 2pm"), "2026-11-12 14:00");
});

test("input ignores case and extra spaces", () => {
	assert.equal(at("  TOMORROW   9:30AM "), "2026-11-13 09:30");
	assert.equal(at("Day After Tomorrow"), "2026-11-14 08:00");
	assert.equal(at("MON 8 AM"), "2026-11-16 08:00");
	assert.equal(at("Feb 1 2027 9am"), "2027-02-01 09:00");
});

test("input not understood or empty", () => {
	assert.equal(refused("anything"), "unknown");
	assert.equal(refused(""), "empty");
	assert.equal(refused("   "), "empty");
	assert.equal(refused("25"), "unknown");
	assert.equal(refused("13pm"), "unknown");
	assert.equal(refused("9:75"), "unknown");
	assert.equal(refused("nov 32"), "unknown");
	assert.equal(refused("feb 30"), "unknown");
	assert.equal(refused("tomorrow 9am 10am"), "unknown");
	assert.equal(refused("tomorrow monday something"), "unknown");
	assert.equal(refused("in"), "unknown");
});

test("clock change: tomorrow 8am on 10/24 12:00 (CEST) = 10/25 08:00 CET = 07:00Z", () => {
	const eve = new Date("2026-10-24T10:00:00Z");
	const r = parseScheduleText("tomorrow 8am", eve, TZ);
	assert.equal(r.ok, true);
	assert.equal((r as { ok: true; at: Date }).at.toISOString(), "2026-10-25T07:00:00.000Z");
	// on the day of the change itself: "in 2h" stays a real duration
	const night = new Date("2026-10-25T00:30:00Z"); // 02:30 CEST
	const r2 = parseScheduleText("in 2h", night, TZ);
	assert.equal((r2 as { ok: true; at: Date }).at.toISOString(), "2026-10-25T02:30:00.000Z");
});

test("other time zone: day and time are those of the given zone", () => {
	const r = parseScheduleText("tomorrow 9am", new Date("2026-11-12T23:30:00Z"), "America/Toronto");
	assert.equal(local((r as { ok: true; at: Date }).at, "America/Toronto"), "2026-11-13 09:00");
});

test("parseTimeText: 9, 9am, 9:30, 09:30, 930, 9:30 PM, noon, midnight", () => {
	assert.deepEqual(parseTimeText("9"), { h: 9, m: 0 });
	assert.deepEqual(parseTimeText("9am"), { h: 9, m: 0 });
	assert.deepEqual(parseTimeText("9:30"), { h: 9, m: 30 });
	assert.deepEqual(parseTimeText("09:30"), { h: 9, m: 30 });
	assert.deepEqual(parseTimeText("930"), { h: 9, m: 30 });
	assert.deepEqual(parseTimeText(" 5:05 PM "), { h: 17, m: 5 });
	assert.deepEqual(parseTimeText("12:15 AM"), { h: 0, m: 15 });
	assert.deepEqual(parseTimeText("noon"), { h: 12, m: 0 });
	assert.deepEqual(parseTimeText("midnight"), { h: 0, m: 0 });
	assert.equal(parseTimeText("24"), null);
	assert.equal(parseTimeText("0am"), null);
	assert.equal(parseTimeText("9:60"), null);
	assert.equal(parseTimeText("tomorrow"), null);
	assert.equal(parseTimeText(""), null);
});

test("the picker's own text (composeText) reads back to the same moment", () => {
	assert.equal(at("Nov 13 8:00 AM"), "2026-11-13 08:00");
	assert.equal(at("Nov 13 12:00 PM"), "2026-11-13 12:00");
	assert.equal(at("Nov 13 08:00"), "2026-11-13 08:00");
	assert.equal(at("Jan 4 2027 5:30 PM"), "2027-01-04 17:30");
	assert.equal(at("Jan 4 2027 17:30"), "2027-01-04 17:30");
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall green");
