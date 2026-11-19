// Bouton « Rejoindre » pour une invitation Google Meet (Samuel le 19/11/2026 : « quand on a une
// invitation google meet il faut afficher un bouton d'ouverture pour que sur tel ce soit fluide et
// sur fixe aussi »). Graph ne remplit onlineMeeting que pour Teams : le lien Meet est lu dans le
// lieu, l'apercu ou le corps (formes relevees sur l'agenda de samuel@ss2i-digital.fr le 19/11).
// Aucune base, aucun reseau reel. Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/meeting-link.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findMeetingUrl, graphJoinUrl, locationIsJustLink, meetingLabel, meetingProvider } from "../../../packages/common/src/meeting-link";
import { listCalendarEvents, listReminderSources, toEventDetail } from "../../../packages/common/src/outlook-graph";

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}\n${(e as Error).stack}`);
	}
}

const ROOT = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

function fakeGraph(value: unknown[]) {
	const urls: URL[] = [];
	const fetchImpl = (async (url: string) => {
		if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
		urls.push(new URL(url));
		return new Response(JSON.stringify({ value }), { status: 200 });
	}) as typeof fetch;
	return { cfg: { tenant: `t-meet-${Math.random()}`, clientId: "c", clientSecret: "s", fetchImpl }, urls };
}

const meetEvent = {
	id: "m1",
	subject: "Echange Technique Sitea // Bakasable - SS2I",
	start: { dateTime: "2026-11-19T09:00:00" },
	end: { dateTime: "2026-11-19T10:00:00" },
	location: { displayName: "https://meet.google.com/ujp-abjc-ktw" },
	onlineMeeting: null,
	isOnlineMeeting: false,
	isOrganizer: false,
	bodyPreview: "Echange Technique / Participer avec Google Meet - Vous avez été invité par Heidi",
};

(async () => {
	await test("lien Meet : lieu seul, lieu avec texte autour, apercu sans schema, corps HTML avec ?hs=", () => {
		assert.equal(findMeetingUrl("https://meet.google.com/ujp-abjc-ktw"), "https://meet.google.com/ujp-abjc-ktw");
		assert.equal(findMeetingUrl("Google Meet (https://meet.google.com/ujp-abjc-ktw?hs=224) ou tél. +33 1 87 40 44 94, code secret 824058506"), "https://meet.google.com/ujp-abjc-ktw");
		assert.equal(findMeetingUrl("Participer avec Google Meet / Lien de la réunion / meet.google.com/kcb-iqqs-zro / "), "https://meet.google.com/kcb-iqqs-zro");
		assert.equal(findMeetingUrl('<a href="https://meet.google.com/uez-qcvs-dwt?hs=224">Participer</a>'), "https://meet.google.com/uez-qcvs-dwt");
		assert.equal(findMeetingUrl("https://meet.google.com/landing"), undefined);
		assert.equal(findMeetingUrl("Salle Atlantique", "", undefined), undefined);
	});

	await test("Teams et Zoom dans un corps HTML (&amp; decode), fournisseur et libelle", () => {
		const teams = findMeetingUrl('<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&amp;anon=true">Rejoindre</a>');
		assert.equal(teams, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&anon=true");
		assert.equal(findMeetingUrl("Zoom : https://us02web.zoom.us/j/8123456789?pwd=abc.1 ID"), "https://us02web.zoom.us/j/8123456789?pwd=abc.1");
		assert.equal(meetingProvider("https://meet.google.com/ujp-abjc-ktw"), "meet");
		assert.equal(meetingProvider(teams), "teams");
		assert.equal(meetingProvider("https://us02web.zoom.us/j/1"), "zoom");
		assert.equal(meetingProvider("https://exemple.fr"), null);
		assert.equal(meetingLabel("https://meet.google.com/ujp-abjc-ktw"), "Google Meet");
		assert.equal(meetingLabel(teams), "Teams");
	});

	await test("evenement Graph : Teams natif prioritaire, sinon lieu, apercu, corps", () => {
		assert.equal(graphJoinUrl({ onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/a" }, location: { displayName: "https://meet.google.com/ujp-abjc-ktw" } }), "https://teams.microsoft.com/l/meetup-join/a");
		assert.equal(graphJoinUrl(meetEvent), "https://meet.google.com/ujp-abjc-ktw");
		assert.equal(graphJoinUrl({ location: { displayName: "" }, bodyPreview: "x", body: { content: '<a href="https://meet.google.com/kcb-iqqs-zro?hs=224">' } }), "https://meet.google.com/kcb-iqqs-zro");
		assert.equal(graphJoinUrl({ location: { displayName: "Bureau" }, bodyPreview: "rien" }), undefined);
	});

	await test("lieu reduit au lien : masque ; lieu avec telephone : garde", () => {
		assert.equal(locationIsJustLink("https://meet.google.com/ujp-abjc-ktw", "https://meet.google.com/ujp-abjc-ktw"), true);
		assert.equal(locationIsJustLink("Google Meet (https://meet.google.com/ujp-abjc-ktw?hs=224) ou tél. +33 1 87 40 44 94", "https://meet.google.com/ujp-abjc-ktw"), false);
		assert.equal(locationIsJustLink("Bureau", undefined), false);
	});

	await test("liste de l'agenda : invitation Meet -> joinUrl, apercu demande a Graph", async () => {
		const { cfg, urls } = fakeGraph([meetEvent]);
		const list = await listCalendarEvents(cfg, "samuel@ss2i-digital.fr", undefined, "2026-11-16", "2026-11-23");
		assert.equal(list[0].joinUrl, "https://meet.google.com/ujp-abjc-ktw");
		assert.match(urls[0].searchParams.get("$select") ?? "", /bodyPreview/);
	});

	await test("detail : lien Meet lu dans le corps quand le lieu est vide", () => {
		const d = toEventDetail({ ...meetEvent, location: { displayName: "" }, bodyPreview: "", body: { content: '<a href="https://meet.google.com/kcb-iqqs-zro?hs=224">Participer avec Google Meet</a>' } }, undefined, "Europe/Paris");
		assert.equal(d?.joinUrl, "https://meet.google.com/kcb-iqqs-zro");
	});

	await test("rappels a paliers : joinUrl Meet et lieu demandes a Graph", async () => {
		const prop = { id: "String {00020329-0000-0000-C000-000000000046} Name ss2iReminders", value: "[60,15,0]" };
		const { cfg, urls } = fakeGraph([{ ...meetEvent, singleValueExtendedProperties: [prop] }]);
		const out = await listReminderSources(cfg, "samuel@ss2i-digital.fr", "2026-11-19T08:00", "2026-11-19T12:00");
		assert.match(urls[0].searchParams.get("$select") ?? "", /bodyPreview/);
		assert.equal(out.length, 1);
		assert.equal(out[0].joinUrl, "https://meet.google.com/ujp-abjc-ktw");
	});

	await test("cablage : bouton par fournisseur, ouverture sans nouvel onglet au tactile, options Teams reservees a Teams", () => {
		const graph = src("packages/common/src/outlook-graph.ts");
		assert.ok(!/raw\?\.onlineMeeting\?\.joinUrl \?/.test(graph), "plus de lecture directe de onlineMeeting.joinUrl : graphJoinUrl partout");
		assert.match(graph, /\/events\/\$\{ref\(id\)\}\?\$select=onlineMeeting,location,bodyPreview,body/);
		const popover = src("apps/web/components/outlook-calendar/event-popover.tsx");
		assert.match(popover, /meetingLabel\(/);
		assert.match(popover, /openMeeting/);
		assert.match(popover, /meetingProvider\([^)]*\) === "teams"/);
		const alerts = src("apps/web/components/outlook-calendar/meeting-alerts.tsx");
		assert.match(alerts, /openMeeting/);
		const actions = src("apps/web/lib/actions/outlook-calendar.ts");
		assert.equal((actions.match(/meetingProvider\(ev\.joinUrl\) !== "teams"/g) ?? []).length, 2);
		assert.match(src("apps/web/lib/event-copy.ts"), /meetingLabel\(/);
	});

	if (failed) {
		console.error(`\n${failed} test(s) en echec`);
		process.exit(1);
	}
	console.log("\nmeeting-link : tout est vert");
})();
