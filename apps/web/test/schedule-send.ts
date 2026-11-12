// Programmer l'envoi (Samuel le 12/11 : ecrire un compte rendu maintenant et le faire partir
// plus tard, pouvoir l'annuler ou le modifier avant). Raccourcis (« Lundi matin » affichait le
// dimanche), verification de l'heure, phase « programme » du badge et de la banniere : parties
// pures, sans base ni Redis.
// Lance par Dockerfile.web avant le build. Depuis la racine :
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
// Jeudi 12/11/2026 10:00 a Paris (UTC+1) = 09:00 UTC.
const THU = new Date("2026-11-12T09:00:00Z");
const hhmm = (d: Date, tz = TZ) =>
	new Intl.DateTimeFormat("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

test("raccourcis du jeudi 12/11 10:00 : +1 h, +2 h, demain 8 h, lundi 8 h", () => {
	const p = schedulePresets(THU, TZ);
	assert.deepEqual(p.map((x) => x.key), ["in1h", "in2h", "tomorrow8", "monday8"]);
	assert.equal(hhmm(p[0].date), "12/11 11:00");
	assert.equal(hhmm(p[1].date), "12/11 12:00");
	assert.equal(hhmm(p[2].date), "13/11 08:00");
	assert.equal(hhmm(p[3].date), "16/11 08:00");
	assert.equal(p[3].labelFr, "Lundi 8 h");
	assert.equal(p[2].labelFr, "Demain 8 h");
	assert.equal(p[0].labelFr, "Dans 1 h");
	assert.equal(p[0].labelEn, "In 1 hour");
});

test("un lundi : « Lundi 8 h » est le lundi suivant, jamais aujourd'hui", () => {
	const mon = new Date("2026-11-16T07:00:00Z"); // lundi 16/11 08:00 Paris
	assert.equal(hhmm(schedulePresets(mon, TZ)[3].date), "23/11 08:00");
	const monEarly = new Date("2026-11-16T05:00:00Z"); // lundi 06:00 : toujours le suivant
	assert.equal(hhmm(schedulePresets(monEarly, TZ)[3].date), "23/11 08:00");
});

test("dimanche, samedi : lundi suivant", () => {
	const sun = new Date("2026-11-15T10:00:00Z");
	assert.equal(hhmm(schedulePresets(sun, TZ)[3].date), "16/11 08:00");
	const sat = new Date("2026-11-14T10:00:00Z");
	assert.equal(hhmm(schedulePresets(sat, TZ)[3].date), "16/11 08:00");
});

test("la date locale fait foi, pas celle d'UTC (00:30 a Paris le 13/11 = 23:30 UTC le 12/11)", () => {
	const late = new Date("2026-11-12T23:30:00Z"); // vendredi 13/11 00:30 Paris
	const p = schedulePresets(late, TZ);
	assert.equal(hhmm(p[2].date), "14/11 08:00");
	assert.equal(hhmm(p[3].date), "16/11 08:00");
});

test("changement d'heure d'automne (lundi 26/10 passe a UTC+1) : 8 h reste 8 h", () => {
	const fri = new Date("2026-10-23T10:00:00Z");
	assert.equal(hhmm(schedulePresets(fri, TZ)[3].date), "26/10 08:00");
	const sat = new Date("2026-10-24T10:00:00Z"); // demain = dimanche 25/10, jour du changement
	assert.equal(hhmm(schedulePresets(sat, TZ)[2].date), "25/10 08:00");
});

test("autre fuseau", () => {
	const p = schedulePresets(THU, "America/Montreal"); // 04:00 a Montreal
	assert.equal(hhmm(p[2].date, "America/Montreal"), "13/11 08:00");
	assert.equal(hhmm(p[0].date, "America/Montreal"), "12/11 05:00");
});

test("formatage : 24 h, jour de la semaine, francais et anglais", () => {
	const at = new Date("2026-11-13T07:00:00Z"); // vendredi 13/11 08:00 Paris
	assert.equal(formatScheduledWhen(at, "fr", TZ, THU), "ven. 13/11 à 08:00");
	assert.equal(formatScheduledWhen(at, "en", TZ, THU), "Fri 13/11 08:00");
	const thu = new Date("2026-11-19T07:00:00Z");
	assert.equal(formatScheduledWhen(thu, "fr", TZ, THU), "jeu. 19/11 à 08:00");
	assert.equal(formatScheduledWhen(new Date("2026-11-12T22:30:00Z"), "fr", TZ, THU), "jeu. 12/11 à 23:30");
});

test("formatage : l'annee n'apparait que si elle change", () => {
	const next = new Date("2027-01-04T07:00:00Z");
	assert.equal(formatScheduledWhen(next, "fr", TZ, THU), "lun. 04/01/2027 à 08:00");
});

test("heure passee de plus d'une minute : refusee ; moins d'une minute : tolerée, partira tout de suite", () => {
	const past = validateScheduledAt("2026-11-12T08:58:00Z", THU.getTime());
	assert.equal(past.ok, false);
	assert.equal((past as any).reason, "past");
	const recent = validateScheduledAt("2026-11-12T08:59:30Z", THU.getTime());
	assert.equal(recent.ok, true);
	assert.equal((recent as any).delayMs, 0);
});

test("heure valide : delai en ms ; texte invalide ou vide : refuse", () => {
	const ok = validateScheduledAt("2026-11-12T11:00:00+02:00", THU.getTime());
	assert.equal(ok.ok, true);
	assert.equal((ok as any).delayMs, 0); // 11:00+02:00 = 09:00Z = maintenant
	const two = validateScheduledAt("2026-11-12T12:00:00+01:00", THU.getTime());
	assert.equal((two as any).delayMs, 2 * 3600_000);
	assert.equal((two as any).at.toISOString(), "2026-11-12T11:00:00.000Z");
	for (const bad of ["", "pas une date", "2026-13-45"]) {
		const r = validateScheduledAt(bad, THU.getTime());
		assert.equal(r.ok, false, bad);
		assert.equal((r as any).reason, "invalid", bad);
	}
});

test("phases : decompte, envoi, programme au-dela de 2 minutes, inconnu", () => {
	const now = THU.getTime();
	const at = (ms: number) => new Date(now + ms).toISOString();
	assert.equal(SCHEDULED_AFTER_MS, 2 * 60_000);
	assert.equal(sendPhaseOf(at(30_000), now), "countdown");
	assert.equal(sendPhaseOf(at(SCHEDULED_AFTER_MS), now), "countdown");
	assert.equal(sendPhaseOf(at(SCHEDULED_AFTER_MS + 1), now), "scheduled");
	assert.equal(sendPhaseOf(at(2 * 3600_000), now), "scheduled");
	assert.equal(sendPhaseOf(at(-1000), now), "sending");
	assert.equal(sendPhaseOf(at(-4 * 60_000), now), "unknown");
	assert.equal(sendPhaseOf("n'importe quoi", now), "unknown");
});

test("libelles : decompte, programme (fr et en), envoi", () => {
	const now = THU.getTime();
	const at = (ms: number) => new Date(now + ms).toISOString();
	const fr = (_en: string, f: string) => f;
	assert.equal(sendLabel(at(30_000), now, fr, TZ), "Envoi dans 30 s");
	assert.equal(sendLabel(at(-1000), now, fr, TZ), "Envoi en cours…");
	// jeudi 19/11 a 08:00 Paris = 07:00 UTC
	assert.equal(sendLabel("2026-11-19T07:00:00.000Z", now, fr, TZ), "Programmé pour jeu. 19/11 à 08:00");
	const en = (e: string) => e;
	assert.equal(sendLabel("2026-11-19T07:00:00.000Z", now, en, TZ), "Scheduled for Thu 19/11 08:00");
	assert.ok(!/ \d{3,} s/.test(sendLabel(at(7200_000), now, fr, TZ)), "jamais « Envoi dans 7200 s »");
});

test("libelle avant montage (fuseau inconnu) : pas d'heure, donc pas de decalage de rendu", () => {
	const now = THU.getTime();
	const fr = (_en: string, f: string) => f;
	assert.equal(sendLabel("2026-11-19T07:00:00.000Z", now, fr, null), "Programmé");
});

test("suivi : programme = ni horloge ni actualisation, un seul reveil au passage au decompte", () => {
	const now = THU.getTime();
	const at = (ms: number) => new Date(now + ms).toISOString();
	const t = sendTrackingOf([at(3 * 3600_000)], now);
	assert.equal(t.fast, false);
	assert.equal(t.wakeAt, now + 3 * 3600_000 - SCHEDULED_AFTER_MS);
	// plusieurs : le reveil est le plus proche, et un decompte en cours reste suivi de pres
	const mixed = sendTrackingOf([at(5 * 3600_000), at(3600_000), at(20_000), null, undefined], now);
	assert.equal(mixed.fast, true);
	assert.equal(mixed.wakeAt, now + 3600_000 - SCHEDULED_AFTER_MS);
	assert.deepEqual(sendTrackingOf([at(30_000)], now), { fast: true, wakeAt: null });
	assert.deepEqual(sendTrackingOf([at(-10_000)], now), { fast: true, wakeAt: null });
	assert.deepEqual(sendTrackingOf([at(-10 * 60_000), "n'importe quoi"], now), { fast: false, wakeAt: null });
	assert.deepEqual(sendTrackingOf([], now), { fast: false, wakeAt: null });
});

// ---------------------------------------------------------------------------
// Saisie libre (« demain 9h30 », « lundi 8h », « dans 2h », « 13/11 10h »).
// Jeudi 12/11/2026 12:21 a Paris (UTC+1) = 11:21 UTC.
const NOW = new Date("2026-11-12T11:21:00Z");
const full = (d: Date, tz = TZ) =>
	new Intl.DateTimeFormat("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
		.format(d)
		.replace(",", "");
const at = (text: string, now: Date = NOW) => {
	const r = parseScheduleText(text, now, TZ);
	assert.equal(r.ok, true, `« ${text} » devrait etre compris : ${JSON.stringify(r)}`);
	return full((r as { ok: true; at: Date }).at);
};
const refused = (text: string, now: Date = NOW) => {
	const r = parseScheduleText(text, now, TZ);
	assert.equal(r.ok, false, `« ${text} » devrait etre refuse : ${JSON.stringify(r)}`);
	return (r as { ok: false; reason: string }).reason;
};

test("heure seule : aujourd'hui si elle est a plus d'une minute, sinon demain", () => {
	assert.equal(at("9h"), "13/11/2026 09:00");
	assert.equal(at("14h"), "12/11/2026 14:00");
	assert.equal(at("midi"), "13/11/2026 12:00");
	assert.equal(at("minuit"), "13/11/2026 00:00");
	assert.equal(at("12h22"), "13/11/2026 12:22"); // dans 1 min pile : pas « a plus d'une minute »
	assert.equal(at("12h23"), "12/11/2026 12:23");
});

test("formes d'heure : 8h, 8h30, 8 h 30, 08:30, 8:30, 830, 9", () => {
	for (const t of ["14h30", "14 h 30", "14:30", "1430", "14h 30"]) assert.equal(at(t), "12/11/2026 14:30", t);
	assert.equal(at("830"), "13/11/2026 08:30");
	assert.equal(at("8:30"), "13/11/2026 08:30");
	assert.equal(at("9"), "13/11/2026 09:00");
});

test("demain, apres-demain, aujourd'hui, avec ou sans heure", () => {
	assert.equal(at("demain"), "13/11/2026 08:00");
	assert.equal(at("demain 9h30"), "13/11/2026 09:30");
	assert.equal(at("demain à 9h30"), "13/11/2026 09:30");
	assert.equal(at("après-demain"), "14/11/2026 08:00");
	assert.equal(at("apres-demain 10h"), "14/11/2026 10:00");
	assert.equal(at("apres demain 10h"), "14/11/2026 10:00");
	assert.equal(at("aujourd'hui 14h"), "12/11/2026 14:00");
	assert.equal(at("auj 15h"), "12/11/2026 15:00");
	assert.equal(at("auj. 15h"), "12/11/2026 15:00");
	assert.equal(refused("auj 9h"), "past");
	assert.equal(refused("aujourd'hui"), "past"); // 08:00 est passe
});

test("jours de la semaine : la prochaine occurrence, strictement apres aujourd'hui", () => {
	assert.equal(at("lundi 8h"), "16/11/2026 08:00");
	assert.equal(at("lun"), "16/11/2026 08:00");
	assert.equal(at("lun."), "16/11/2026 08:00");
	assert.equal(at("Lundi"), "16/11/2026 08:00");
	assert.equal(at("vendredi 9h"), "13/11/2026 09:00");
	assert.equal(at("jeudi"), "19/11/2026 08:00"); // aujourd'hui est jeudi : la semaine prochaine
	assert.equal(at("jeu 10h"), "19/11/2026 10:00");
	assert.equal(at("dimanche 18h"), "15/11/2026 18:00");
	const mon = new Date("2026-11-16T10:00:00Z");
	assert.equal(at("lundi", mon), "23/11/2026 08:00");
});

test("dans N : heures, minutes, jours", () => {
	assert.equal(at("dans 2h"), "12/11/2026 14:21");
	assert.equal(at("dans 2 h"), "12/11/2026 14:21");
	assert.equal(at("dans 30 min"), "12/11/2026 12:51");
	assert.equal(at("dans 1h30"), "12/11/2026 13:51");
	assert.equal(at("dans 3 jours"), "15/11/2026 08:00");
	assert.equal(at("Dans  45  minutes"), "12/11/2026 13:06");
});

test("dates : 13/11, 13/11/2026, 13/11/26, 13 novembre, avec ou sans heure", () => {
	assert.equal(at("13/11 10h"), "13/11/2026 10:00");
	assert.equal(at("13/11"), "13/11/2026 08:00");
	assert.equal(at("13/11/2026 9h"), "13/11/2026 09:00");
	assert.equal(at("13/11/26 9h"), "13/11/2026 09:00");
	assert.equal(at("13 novembre"), "13/11/2026 08:00");
	assert.equal(at("13 novembre 10h30"), "13/11/2026 10:30");
	assert.equal(at("1er décembre 9h"), "01/12/2026 09:00");
	assert.equal(at("le 20 nov à 7h"), "20/11/2026 07:00");
	assert.equal(at("13 novembre 2027 9h"), "13/11/2027 09:00");
});

test("une date passee sans annee est l'an prochain ; avec annee, elle est refusee", () => {
	assert.equal(at("1/1 9h"), "01/01/2027 09:00");
	assert.equal(at("11/11"), "11/11/2027 08:00");
	assert.equal(refused("12/11/2025 9h"), "past");
	assert.equal(refused("12/11 9h"), "past"); // aujourd'hui, heure passee : pas l'an prochain
	assert.equal(at("12/11 14h"), "12/11/2026 14:00");
});

test("saisie insensible a la casse, aux accents et aux espaces", () => {
	assert.equal(at("  DEMAIN   9H30 "), "13/11/2026 09:30");
	assert.equal(at("Après-Demain"), "14/11/2026 08:00");
	assert.equal(at("LUN 8 H"), "16/11/2026 08:00");
	assert.equal(at("1 févr 2027 9h"), "01/02/2027 09:00");
});

test("saisie incomprise ou vide", () => {
	assert.equal(refused("n'importe quoi"), "unknown");
	assert.equal(refused(""), "empty");
	assert.equal(refused("   "), "empty");
	assert.equal(refused("25h"), "unknown");
	assert.equal(refused("9h75"), "unknown");
	assert.equal(refused("32/11"), "unknown");
	assert.equal(refused("30/02"), "unknown");
	assert.equal(refused("demain 9h 10h"), "unknown");
	assert.equal(refused("demain lundi quelque chose"), "unknown");
	assert.equal(refused("dans"), "unknown");
});

test("changement d'heure : demain 8h le 24/10 12:00 (CEST) = 25/10 08:00 CET = 07:00Z", () => {
	const eve = new Date("2026-10-24T10:00:00Z");
	const r = parseScheduleText("demain 8h", eve, TZ);
	assert.equal(r.ok, true);
	assert.equal((r as { ok: true; at: Date }).at.toISOString(), "2026-10-25T07:00:00.000Z");
	// le jour du passage lui-meme : « dans 2h » reste une duree reelle
	const night = new Date("2026-10-25T00:30:00Z"); // 02:30 CEST
	const r2 = parseScheduleText("dans 2h", night, TZ);
	assert.equal((r2 as { ok: true; at: Date }).at.toISOString(), "2026-10-25T02:30:00.000Z");
});

test("autre fuseau : le jour et l'heure sont ceux du fuseau demande", () => {
	const r = parseScheduleText("demain 9h", new Date("2026-11-12T23:30:00Z"), "America/Toronto");
	assert.equal(full((r as { ok: true; at: Date }).at, "America/Toronto"), "13/11/2026 09:00");
});

test("parseTimeText : 9, 9h, 9h30, 09:30, 930", () => {
	assert.deepEqual(parseTimeText("9"), { h: 9, m: 0 });
	assert.deepEqual(parseTimeText("9h"), { h: 9, m: 0 });
	assert.deepEqual(parseTimeText("9h30"), { h: 9, m: 30 });
	assert.deepEqual(parseTimeText("09:30"), { h: 9, m: 30 });
	assert.deepEqual(parseTimeText("930"), { h: 9, m: 30 });
	assert.deepEqual(parseTimeText(" 17 h 05 "), { h: 17, m: 5 });
	assert.deepEqual(parseTimeText("midi"), { h: 12, m: 0 });
	assert.deepEqual(parseTimeText("minuit"), { h: 0, m: 0 });
	assert.equal(parseTimeText("24h"), null);
	assert.equal(parseTimeText("9h60"), null);
	assert.equal(parseTimeText("demain"), null);
	assert.equal(parseTimeText(""), null);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
