// Rappels de reunion a plusieurs paliers (Samuel le 19/11/2026 : « un rappel au moment de la
// reunion, un rappel 15 minutes avant et un rappel une heure avant ») : Graph ne porte qu'un
// rappel natif par evenement, courrier calcule les autres a partir de la propriete etendue
// ss2iReminders et les affiche dans le bandeau d'alerte, un seul bandeau par evenement, chaque
// palier sonnant a son heure et se fermant seul. Aucune base, aucun reseau reel.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/meeting-reminders.ts
import assert from "node:assert/strict";
import {
	ALERT_AFTER_MIN,
	alertDue,
	applySnoozes,
	bannerList,
	countdownLabel,
	extraReminders,
	mergeReminders,
	parseReminderOffsets,
	reminderKey,
	type ReminderSource,
} from "../../../packages/common/src/meeting-reminders";
import { listReminderSources, type DueReminder } from "../../../packages/common/src/outlook-graph";
import { REMINDERS_PROPERTY_ID } from "../../../packages/common/src/thread-agenda";

let failures = 0;
const test = async (label: string, fn: () => void | Promise<void>) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const src = (over: Partial<ReminderSource> = {}): ReminderSource => ({
	eventId: "e1",
	title: "Copil Antellia",
	start: "2026-11-20T09:00",
	end: "2026-11-20T10:00",
	nativeMinutes: 60,
	offsets: [60, 15, 0],
	...over,
});
const fires = (l: DueReminder[]) => l.map((r) => r.fireAt);

(async () => {
	await test("offsets lus dans la propriete : tries du plus lointain au plus proche, sans doublon, bruit ecarte", () => {
		assert.deepEqual(parseReminderOffsets("60,15,0"), [60, 15, 0]);
		assert.deepEqual(parseReminderOffsets("0, 15,60,15"), [60, 15, 0]);
		assert.deepEqual(parseReminderOffsets("abc,-5,15,1.5,,99999"), [15]);
		assert.deepEqual(parseReminderOffsets(""), []);
		assert.deepEqual(parseReminderOffsets(undefined), []);
		assert.deepEqual(parseReminderOffsets(42), []);
	});

	await test("paliers supplementaires : tous sauf le rappel natif, heure = debut - ecart", () => {
		const r = extraReminders([src()]);
		assert.deepEqual(fires(r), ["2026-11-20T08:45", "2026-11-20T09:00"]);
		assert.ok(r.every((x) => x.extra === true && x.eventId === "e1" && x.title === "Copil Antellia" && x.end === "2026-11-20T10:00"));
	});

	await test("paliers supplementaires : rappel natif absent ou different de la liste, journee entiere et sans propriete ecartees", () => {
		assert.deepEqual(fires(extraReminders([src({ nativeMinutes: null })])), ["2026-11-20T08:00", "2026-11-20T08:45", "2026-11-20T09:00"]);
		assert.deepEqual(fires(extraReminders([src({ nativeMinutes: 30 })])), ["2026-11-20T08:00", "2026-11-20T08:45", "2026-11-20T09:00"]);
		assert.deepEqual(extraReminders([src({ allDay: true, offsets: [960] })]), []);
		assert.deepEqual(extraReminders([src({ offsets: [] })]), []);
	});

	await test("paliers supplementaires : passage de minuit", () => {
		assert.deepEqual(fires(extraReminders([src({ start: "2026-11-20T00:10", end: "2026-11-20T01:00", nativeMinutes: null, offsets: [60] })])), ["2026-11-19T23:10"]);
	});

	await test("fusion : un palier deja connu d'Outlook (meme evenement, meme heure) n'est pas double, tri par heure", () => {
		const native: DueReminder[] = [{ eventId: "e1", title: "Copil Antellia", start: "2026-11-20T09:00", end: "2026-11-20T10:00", fireAt: "2026-11-20T08:00" }];
		const extra = extraReminders([src({ nativeMinutes: null })]);
		const m = mergeReminders(native, extra);
		assert.deepEqual(fires(m), ["2026-11-20T08:00", "2026-11-20T08:45", "2026-11-20T09:00"]);
		assert.equal(m[0].extra, undefined, "le natif garde la main : fermer vaut dans Outlook");
		assert.equal(mergeReminders([], []).length, 0);
	});

	await test("alerte due : heure du palier passee, reunion pas finie ni commencee depuis plus de 10 min", () => {
		const r = extraReminders([src()])[0];
		assert.equal(ALERT_AFTER_MIN, 10);
		assert.equal(alertDue(r, "2026-11-20T08:44"), false);
		assert.equal(alertDue(r, "2026-11-20T08:45"), true);
		assert.equal(alertDue(r, "2026-11-20T09:10"), true);
		assert.equal(alertDue(r, "2026-11-20T09:11"), false);
		assert.equal(countdownLabel("2026-11-20T09:00", "2026-11-20T08:45"), "Commence dans 15 min");
		assert.equal(countdownLabel("2026-11-20T09:00", "2026-11-20T09:02"), "A commencé il y a 2 min");
	});

	const tiers = mergeReminders([{ eventId: "e1", title: "Copil Antellia", start: "2026-11-20T09:00", end: "2026-11-20T10:00", fireAt: "2026-11-20T08:00" }], extraReminders([src()]));
	const [t60, t15, t0] = tiers;

	await test("bandeau : un seul par evenement, le palier le plus recent remplace le precedent", () => {
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T07:59", new Set())), []);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T08:10", new Set())), ["2026-11-20T08:00"]);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T08:50", new Set())), ["2026-11-20T08:45"]);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T09:00", new Set())), ["2026-11-20T09:00"]);
	});

	await test("bandeau : fermer le palier 1 h ne fait taire ni 15 min ni l'heure pile", () => {
		const closed = new Set([reminderKey(t60)]);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T08:10", closed)), []);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T08:50", closed)), ["2026-11-20T08:45"]);
		const closed2 = new Set([reminderKey(t60), reminderKey(t15)]);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T08:55", closed2)), []);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T09:00", closed2)), ["2026-11-20T09:00"]);
	});

	await test("bandeau : palier recent ferme, le precedent (remplace) ne revient pas", () => {
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T08:50", new Set([reminderKey(t15)]))), []);
		assert.deepEqual(fires(bannerList(tiers, "2026-11-20T09:05", new Set([reminderKey(t0)]))), []);
	});

	await test("bandeau : plusieurs evenements, tries par debut, chacun avec son palier", () => {
		const other = extraReminders([src({ eventId: "e2", title: "Point equipe", start: "2026-11-20T08:55", end: "2026-11-20T09:30", nativeMinutes: null, offsets: [15] })]);
		const l = bannerList([...tiers, ...other], "2026-11-20T08:50", new Set());
		assert.deepEqual(l.map((r) => `${r.eventId}@${r.fireAt}`), ["e2@2026-11-20T08:40", "e1@2026-11-20T08:45"]);
	});

	await test("palier repousse : nouvelle heure gardee apres une relecture, le natif n'est pas touche", () => {
		const snoozes = { [reminderKey(t15)]: "2026-11-20T08:50" };
		const l = applySnoozes(tiers, snoozes);
		assert.deepEqual(fires(l), ["2026-11-20T08:00", "2026-11-20T08:50", "2026-11-20T09:00"]);
		assert.deepEqual(fires(applySnoozes(tiers, { [reminderKey(t60)]: "2026-11-20T08:50" })), fires(tiers));
		// repousser ferme aussi les paliers plus anciens (sinon le palier 1 h reviendrait pendant le report)
		const closed = new Set([reminderKey(t60), reminderKey(t15)]);
		assert.deepEqual(fires(bannerList(l, "2026-11-20T08:47", closed)), []);
		assert.deepEqual(fires(bannerList(l, "2026-11-20T08:51", closed)), ["2026-11-20T08:50"]);
	});

	await test("Graph : calendarView avec la propriete etendue, evenements annules, journee entiere et sans propriete ecartes", async () => {
		const urls: string[] = [];
		// Graph renvoie l'identifiant avec le GUID en minuscules (verifie sur le vrai tenant le 19/11).
		const prop = (value: string) => [{ id: REMINDERS_PROPERTY_ID.toLowerCase().replace("name ss2ireminders", "Name ss2iReminders").replace("string ", "String "), value }];
		const fetchImpl = (async (url: string) => {
			if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			urls.push(decodeURIComponent(url));
			return new Response(
				JSON.stringify({
					value: [
						{ id: "a", subject: "Copil", start: { dateTime: "2026-11-20T09:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-20T10:00:00", timeZone: "Europe/Paris" }, isReminderOn: true, reminderMinutesBeforeStart: 60, singleValueExtendedProperties: prop("60,15,0"), location: { displayName: "Salle 2" }, onlineMeeting: { joinUrl: "https://teams.example/j" }, webLink: "https://o/x" },
						{ id: "b", subject: "Annule", isCancelled: true, start: { dateTime: "2026-11-20T09:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-20T10:00:00", timeZone: "Europe/Paris" }, singleValueExtendedProperties: prop("15") },
						{ id: "c", subject: "Journee", isAllDay: true, start: { dateTime: "2026-11-20T00:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-21T00:00:00", timeZone: "Europe/Paris" }, singleValueExtendedProperties: prop("960") },
						{ id: "d", subject: "Sans propriete", start: { dateTime: "2026-11-20T11:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-20T12:00:00", timeZone: "Europe/Paris" }, isReminderOn: true, reminderMinutesBeforeStart: 15 },
						{ id: "e", subject: "Rappel coupe", start: { dateTime: "2026-11-20T13:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-20T14:00:00", timeZone: "Europe/Paris" }, isReminderOn: false, singleValueExtendedProperties: prop("15,0") },
					],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const cfg = { tenant: "t-extra", clientId: "c", clientSecret: "s", fetchImpl };
		const list = await listReminderSources(cfg, "hugo@x.fr", "2026-11-19T00:00", "2026-11-22T00:00");
		assert.ok(urls[0].includes("/users/hugo@x.fr/calendarView?"));
		assert.ok(urls[0].includes(`$expand=singleValueExtendedProperties($filter=id eq '${REMINDERS_PROPERTY_ID}')`));
		assert.ok(urls[0].includes("startDateTime=2026-11-19T00:00:00"));
		assert.deepEqual(list.map((s) => [s.eventId, s.nativeMinutes, s.offsets]), [["a", 60, [60, 15, 0]], ["e", null, [15, 0]]]);
		assert.equal(list[0].title, "Copil");
		assert.equal(list[0].location, "Salle 2");
		assert.equal(list[0].joinUrl, "https://teams.example/j");
		assert.equal(list[0].start, "2026-11-20T09:00");
	});

	if (failures) {
		console.log(`\n${failures} echec(s)`);
		process.exit(1);
	}
	console.log("\ntous les tests passent");
})();
