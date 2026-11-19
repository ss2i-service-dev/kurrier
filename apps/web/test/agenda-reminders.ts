// « Ajouter a l'agenda » (Samuel le 19/11/2026 : « toute la journee, c'est jamais [...] on
// propose a la saisie, mais on met jamais par defaut sur toute la journee. Et les rappels, par
// defaut, [...] au moment de la reunion, 15 minutes avant et une heure avant. Et si on a envie,
// on les decoche ») : une proposition en journee entiere devient horaire (a verifier), rappels
// coches d'emblee, corps Graph. Aucune base, aucun reseau.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/agenda-reminders.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultReminders,
	graphEventBody,
	normalizeAgendaEvent,
	proposalAsTimed,
	REMINDERS_PROPERTY_ID,
	type AgendaEvent,
} from "../../../packages/common/src/thread-agenda";

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

const day = (over: Partial<AgendaEvent>): AgendaEvent => ({ title: "Stagiaire dev", allDay: true, start: "2026-12-07", end: "2026-12-07", sourceQuote: "", ...over });
const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("proposition d'un jour sans heure : 09:00 a 10:00, heure a verifier", () => {
	const { event, timeToCheck } = proposalAsTimed(day({}));
	assert.equal(event.allDay, false);
	assert.equal(event.start, "2026-12-07T09:00");
	assert.equal(event.end, "2026-12-07T10:00");
	assert.equal(timeToCheck, true);
	assert.equal(event.title, "Stagiaire dev");
	// fin absente : le meme jour
	assert.equal(proposalAsTimed(day({ end: "" })).event.end, "2026-12-07T10:00");
});

test("proposition de plusieurs jours : 09:00 le premier jour, 18:00 le dernier", () => {
	const { event, timeToCheck } = proposalAsTimed(day({ end: "2026-12-11" }));
	assert.equal(event.start, "2026-12-07T09:00");
	assert.equal(event.end, "2026-12-11T18:00");
	assert.equal(timeToCheck, true);
});

test("proposition deja horaire : inchangee, rien a verifier", () => {
	const e = day({ allDay: false, start: "2026-12-08T14:00", end: "2026-12-08T15:30" });
	const r = proposalAsTimed(e);
	assert.deepEqual(r.event, e);
	assert.equal(r.timeToCheck, false);
});

test("la proposition convertie passe la validation et ne garde pas le choix de rappels de la journee entiere", () => {
	const { event } = proposalAsTimed(day({ end: "2026-12-11", reminders: [960] }));
	const n = normalizeAgendaEvent(event);
	assert.ok("event" in n);
	if ("event" in n) {
		assert.equal(n.event.allDay, false);
		assert.deepEqual(n.event.reminders, [60, 15, 0]);
	}
});

test("rappels par defaut : trois paliers pour un horaire, la veille a 8 h pour une journee entiere", () => {
	assert.deepEqual(defaultReminders(false), [60, 15, 0]);
	assert.deepEqual(defaultReminders(true), [960]);
});

test("corps Graph d'un horaire sans choix : rappel natif 1 h, liste complete en propriete etendue", () => {
	const n = normalizeAgendaEvent({ title: "Copil", start: "2026-12-08T14:00", end: "2026-12-08T15:00" });
	assert.ok("event" in n);
	if (!("event" in n)) return;
	const b: any = graphEventBody(n.event);
	assert.equal(b.isReminderOn, true);
	assert.equal(b.reminderMinutesBeforeStart, 60);
	assert.deepEqual(b.singleValueExtendedProperties, [{ id: REMINDERS_PROPERTY_ID, value: "60,15,0" }]);
});

test("interface : cases a cocher pour l'horaire, choix unique pour la journee entiere, indicateur d'heure a verifier, plus de « aucun rappel par defaut »", () => {
	const steps = read("apps/web/components/mailbox/default/add-to-agenda-steps.tsx");
	const main = read("apps/web/components/mailbox/default/add-to-agenda.tsx");
	assert.match(steps, /TIMED_REMINDERS/);
	assert.match(steps, /Checkbox/);
	assert.match(steps, /ALL_DAY_REMINDERS/);
	assert.match(steps, /Heure à vérifier : le fil n'en donne pas/);
	assert.match(main, /proposalAsTimed/);
	assert.doesNotMatch(main + steps, /Aucun rappel par défaut/);
	assert.doesNotMatch(main + steps, /reminder: "none"|reminder: allDay/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
