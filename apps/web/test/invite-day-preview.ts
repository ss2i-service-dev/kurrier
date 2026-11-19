// Encart « agenda du jour » au-dessus d'une invitation (Samuel le 19/11/2026 : « quand je recois
// une invitation comme ca, j'ai envie de voir directement au-dessus du mail, dans un petit
// encart, a quel endroit sur le calendrier ca va se positionner l'invitation en question.
// Histoire que je vois s'il y a des conflits, des trucs juste avant, juste apres [...] Sans avoir
// a aller sur le calendrier en lui-meme et perdre le contexte »). Jour de l'invitation a Paris,
// invitation en evenement fantome, dedoublonnage avec l'evenement deja accepte, conflits,
// journee entiere, lien vers la page agenda. Aucune base, aucun reseau.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/invite-day-preview.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	agendaDateParam,
	agendaUrl,
	conflictLabel,
	findExistingEvent,
	inviteConflicts,
	invitePreviewEvents,
	inviteScrollMinutes,
	inviteSlot,
} from "../lib/invite-preview";

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

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const ev = (id: string, title: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ id, title, allDay: false, start, end, ...extra });
const day = (id: string, title: string, d: string, extra: Record<string, unknown> = {}) => ({ id, title, allDay: true, start: d, end: d, ...extra });

// 11:30 a Paris le 19/11/2026 (hiver, UTC+1) = 10:30 UTC.
const invite = { title: "Point Sitea", isAllDay: false, startsAt: "2026-11-19T10:30:00.000Z", endsAt: "2026-11-19T11:30:00.000Z" };

test("fuseau : 10:30 UTC en hiver est 11:30 a Paris, le bon jour", () => {
	const s = inviteSlot(invite)!;
	assert.equal(s.day, "2026-11-19");
	assert.equal(s.start, "2026-11-19T11:30");
	assert.equal(s.end, "2026-11-19T12:30");
	assert.equal(s.allDay, false);
});

test("fuseau : 22:30 UTC la veille (heure d'ete) est 00:30 a Paris le lendemain", () => {
	const s = inviteSlot({ ...invite, startsAt: "2026-07-14T22:30:00.000Z", endsAt: "2026-07-14T23:00:00.000Z" })!;
	assert.equal(s.day, "2026-07-15");
	assert.equal(s.start, "2026-07-15T00:30");
	assert.equal(s.end, "2026-07-15T01:00");
});

test("date reprise telle quelle depuis un objet Date ou la chaine d'un Date", () => {
	const d = new Date("2026-11-19T10:30:00.000Z");
	assert.equal(inviteSlot({ ...invite, startsAt: d, endsAt: new Date("2026-11-19T11:00:00.000Z") })!.start, "2026-11-19T11:30");
	assert.equal(inviteSlot({ ...invite, startsAt: String(d), endsAt: String(new Date("2026-11-19T11:00:00.000Z")) })!.start, "2026-11-19T11:30");
});

test("sans date ou date illisible : pas d'encart", () => {
	assert.equal(inviteSlot({ ...invite, startsAt: null }), null);
	assert.equal(inviteSlot({ ...invite, startsAt: undefined }), null);
	assert.equal(inviteSlot({ ...invite, startsAt: "n'importe quoi" }), null);
});

test("fin absente ou avant le debut : une demi-heure", () => {
	assert.equal(inviteSlot({ ...invite, endsAt: null })!.end, "2026-11-19T12:00");
	assert.equal(inviteSlot({ ...invite, endsAt: "2026-11-19T09:00:00.000Z" })!.end, "2026-11-19T12:00");
});

test("journee entiere : premier jour, debut et fin sur ce jour (plusieurs jours : le premier)", () => {
	const s = inviteSlot({ title: "Seminaire", isAllDay: true, startsAt: "2026-11-19T23:00:00.000Z", endsAt: "2026-11-22T23:00:00.000Z" })!;
	assert.equal(s.allDay, true);
	assert.equal(s.day, "2026-11-20");
	assert.equal(s.start, "2026-11-20");
	assert.equal(s.end, "2026-11-20");
});

test("l'invitation devient un evenement fantome actif, au format de la grille", () => {
	const s = inviteSlot(invite)!;
	const out = invitePreviewEvents(s, [ev("a", "Autre", "2026-11-19T09:00", "2026-11-19T10:00")]);
	assert.equal(out.length, 2);
	const g = out.find((e) => e.ghost)!;
	assert.equal(g.title, "Point Sitea");
	assert.equal(g.start, "2026-11-19T11:30");
	assert.equal(g.end, "2026-11-19T12:30");
	assert.equal(g.allDay, false);
	assert.equal(g.active, true);
	assert.equal(out.find((e) => e.id === "a")!.ghost, undefined);
});

test("titre vide : un libelle", () => {
	const g = invitePreviewEvents(inviteSlot({ ...invite, title: "" })!, []).find((e) => e.ghost)!;
	assert.ok(g.title.length > 0);
});

test("deja dans l'agenda (invitation acceptee) : meme titre a la casse et aux espaces pres, meme debut -> pas de doublon, l'existant devient actif", () => {
	const s = inviteSlot(invite)!;
	const existing = [ev("x", "  point   SITEA ", "2026-11-19T11:30", "2026-11-19T12:30"), ev("y", "Autre", "2026-11-19T11:00", "2026-11-19T12:00")];
	assert.equal(findExistingEvent(s, existing)?.id, "x");
	const out = invitePreviewEvents(s, existing);
	assert.equal(out.length, 2);
	assert.equal(out.filter((e) => e.ghost).length, 0);
	assert.equal(out.find((e) => e.id === "x")!.active, true);
	assert.equal(out.find((e) => e.id === "y")!.active, undefined);
});

test("meme titre mais autre heure, ou meme heure et autre titre : pas le meme evenement", () => {
	const s = inviteSlot(invite)!;
	assert.equal(findExistingEvent(s, [ev("x", "Point Sitea", "2026-11-19T14:00", "2026-11-19T15:00")]), null);
	assert.equal(findExistingEvent(s, [ev("x", "Autre chose", "2026-11-19T11:30", "2026-11-19T12:30")]), null);
	assert.equal(invitePreviewEvents(s, [ev("x", "Point Sitea", "2026-11-19T14:00", "2026-11-19T15:00")]).filter((e) => e.ghost).length, 1);
});

test("conflits : chevauchement strict, un evenement qui finit a 11:30 n'est pas en conflit avec celui qui commence a 11:30", () => {
	const s = inviteSlot(invite)!;
	const list = [
		ev("avant", "Avant", "2026-11-19T10:30", "2026-11-19T11:30"),
		ev("apres", "Apres", "2026-11-19T12:30", "2026-11-19T13:30"),
		ev("recouvre", "Recouvre", "2026-11-19T12:00", "2026-11-19T13:00"),
		ev("contient", "Contient", "2026-11-19T11:00", "2026-11-19T13:00"),
		ev("dedans", "Dedans", "2026-11-19T11:45", "2026-11-19T12:00"),
	];
	assert.deepEqual(
		inviteConflicts(s, list).map((c) => c.id).sort(),
		["contient", "dedans", "recouvre"],
	);
});

test("conflits : disponible, refuse, journee entiere ordinaire et l'invitation elle-meme ne comptent pas", () => {
	const s = inviteSlot(invite)!;
	const list = [
		ev("libre", "Libre", "2026-11-19T11:00", "2026-11-19T12:00", { showAs: "free" }),
		ev("refuse", "Refuse", "2026-11-19T11:00", "2026-11-19T12:00", { responseStatus: "declined" }),
		day("jour", "Ferie", "2026-11-19", { showAs: "free" }),
		day("jourbusy", "Journee occupee", "2026-11-19", { showAs: "busy" }),
		ev("moi", "Point Sitea", "2026-11-19T11:30", "2026-11-19T12:30", { showAs: "busy" }),
		ev("provisoire", "Provisoire", "2026-11-19T12:00", "2026-11-19T12:15", { showAs: "tentative" }),
	];
	assert.deepEqual(inviteConflicts(s, list).map((c) => c.id), ["provisoire"]);
});

test("conflits : absence du bureau sur la journee entiere compte pour une invitation horaire", () => {
	const s = inviteSlot(invite)!;
	assert.deepEqual(inviteConflicts(s, [day("conges", "Conges", "2026-11-19", { showAs: "oof" })]).map((c) => c.id), ["conges"]);
});

test("conflits : evenement sur plusieurs jours qui recouvre l'invitation", () => {
	const s = inviteSlot(invite)!;
	assert.deepEqual(inviteConflicts(s, [ev("long", "Voyage", "2026-11-18T20:00", "2026-11-20T08:00")]).map((c) => c.id), ["long"]);
});

test("conflits : invitation en journee entiere, seules les autres journees entieres occupees comptent", () => {
	const s = inviteSlot({ title: "Seminaire", isAllDay: true, startsAt: "2026-11-19T23:00:00.000Z", endsAt: "2026-11-20T23:00:00.000Z" })!;
	const list = [
		ev("h", "Reunion", "2026-11-20T10:00", "2026-11-20T11:00"),
		day("o", "Deplacement", "2026-11-20", { showAs: "busy" }),
		day("f", "Ferie", "2026-11-20", { showAs: "free" }),
		day("autre", "Autre jour", "2026-11-21", { showAs: "busy" }),
	];
	assert.deepEqual(inviteConflicts(s, list).map((c) => c.id), ["o"]);
});

test("journee entiere deja dans l'agenda : meme titre et meme jour, pas de doublon", () => {
	const s = inviteSlot({ title: "Seminaire", isAllDay: true, startsAt: "2026-11-19T23:00:00.000Z", endsAt: "2026-11-20T23:00:00.000Z" })!;
	const out = invitePreviewEvents(s, [day("sem", "seminaire", "2026-11-20", { end: "2026-11-21" })]);
	assert.equal(out.length, 1);
	assert.equal(out[0].active, true);
	assert.deepEqual(inviteConflicts(s, [day("sem", "seminaire", "2026-11-20", { showAs: "busy" })]), []);
});

test("libelle d'un conflit : titre et horaires en 24 h, tronques au jour affiche", () => {
	const s = inviteSlot(invite)!;
	const [c] = inviteConflicts(s, [ev("a", "Point Acme", "2026-11-19T10:00", "2026-11-19T15:00")]);
	assert.equal(conflictLabel(c), "Point Acme (10:00-15:00)");
	const [l] = inviteConflicts(s, [ev("v", "Voyage", "2026-11-18T20:00", "2026-11-20T08:00")]);
	assert.equal(conflictLabel(l), "Voyage (00:00-24:00)");
	const [j] = inviteConflicts(s, [day("j", "Conges", "2026-11-19", { showAs: "oof" })]);
	assert.equal(conflictLabel(j, "All day"), "Conges (All day)");
	assert.doesNotMatch(conflictLabel(c), /AM|PM/i);
});

test("defilement : une heure avant le debut, jamais negatif ; journee entiere : 8 h", () => {
	assert.equal(inviteScrollMinutes(inviteSlot(invite)!), 10 * 60 + 30);
	assert.equal(inviteScrollMinutes(inviteSlot({ ...invite, startsAt: "2026-11-19T07:30:00.000Z", endsAt: "2026-11-19T08:00:00.000Z" })!), 7 * 60 + 30);
	assert.equal(inviteScrollMinutes(inviteSlot({ ...invite, startsAt: "2026-11-18T23:15:00.000Z", endsAt: "2026-11-18T23:45:00.000Z" })!), 0);
	assert.equal(inviteScrollMinutes(inviteSlot({ title: "S", isAllDay: true, startsAt: "2026-11-19T23:00:00.000Z", endsAt: "2026-11-20T23:00:00.000Z" })!), 8 * 60);
});

test("URL de l'agenda : jour et boite, lue a l'ouverture", () => {
	assert.equal(agendaUrl("ws1", "2026-11-19", "idn1"), "/w/ws1/dashboard/agenda?date=2026-11-19&box=idn1");
	assert.equal(agendaDateParam("?date=2026-11-19&box=x"), "2026-11-19");
	assert.equal(agendaDateParam("date=2026-11-19"), "2026-11-19");
	assert.equal(agendaDateParam("?date=2026-13-45"), null);
	assert.equal(agendaDateParam("?date=demain"), null);
	assert.equal(agendaDateParam(""), null);
});

test("cablage : la carte d'invitation monte l'encart, au-dessus du bloc titre et reponse", () => {
	const s = src("components/mailbox/default/render-invite.tsx");
	assert.match(s, /import InviteDayPreview from "@\/components\/outlook-calendar\/invite-day-preview"/);
	const preview = s.indexOf("<InviteDayPreview");
	assert.ok(preview > 0, "InviteDayPreview monte");
	assert.ok(preview < s.indexOf("{calendarEvent.title"), "avant le titre");
	// Les deux interfaces passent par RenderInvite.
	assert.match(src("components/k/thread-item.tsx"), /<RenderInvite/);
	assert.match(src("components/mailbox/default/thread-item.tsx"), /<RenderInvite/);
});

test("cablage : l'encart est en lecture seule, sans creation ni deplacement", () => {
	const s = src("components/outlook-calendar/invite-day-preview.tsx");
	const grid = s.slice(s.indexOf("<CalendarGrid"), s.indexOf("/>", s.indexOf("<CalendarGrid")));
	assert.ok(grid.length > 20, "CalendarGrid monte");
	for (const prop of ["onSlot", "onRange", "onMove", "onAllDaySlot"]) assert.ok(!grid.includes(prop), `${prop} absent`);
	assert.match(s, /useOutlookEvents\(/);
	assert.match(s, /agendaUrl\(/);
	// Identite sans Outlook ou erreur de lecture : rien d'affiche.
	assert.match(s, /if \(!slot \|\| error\) return null|error \|\| !slot/);
});

test("cablage : la page agenda s'ouvre sur le jour de ?date= sans toucher a la memoire de vue", () => {
	const s = src("components/outlook-calendar/agenda-page.tsx");
	assert.match(s, /agendaDateParam\(/);
	assert.match(s, /agendaStore\.setAnchor\(/);
	assert.doesNotMatch(s, /agendaStore\.setView\(date/);
});

// Regle des 24 h (Samuel) : la carte d'invitation affichait « 11:30 AM - 12:00 PM ».
test("carte d'invitation : heures en 24 h, jamais AM/PM", () => {
	const card = src("components/mailbox/default/render-invite.tsx");
	const formats = card.match(/new Intl\.DateTimeFormat\([^)]*\{[\s\S]*?\}\)/g) ?? [];
	const withHour = formats.filter((f) => /hour:/.test(f));
	assert.ok(withHour.length >= 2, "formats d'heure introuvables");
	for (const f of withHour) assert.match(f, /hourCycle: "h23"/, `format sans 24 h : ${f.slice(0, 80)}`);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\ninvite-day-preview : tous les tests passent");
