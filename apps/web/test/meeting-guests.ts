// Reunion avec d'autres personnes reperable dans l'agenda (Samuel le 24/11/2026 : « quand c'est une
// reunion a plusieurs et pas juste une entree dans l'agenda, [...] un truc qui nous indique que
// celle-la faut faire gaffe [...] ca depend de quelqu'un d'autre. Peut-etre avec autant de petits
// icones de buddy qu'il y a de gens qui sont convies »). Cas d'origine : « [SS2i Services - Groupe
// LIBAUD] Presentation BASTION » du 24/11, organisee par Christophe, sans lien Teams.
// Aucune base, aucun reseau reel. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/meeting-guests.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guestBuddies, meetingGuests } from "../../../packages/common/src/meeting-guests";
import { listCalendarEvents } from "../../../packages/common/src/outlook-graph";

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
const ME = "samuel@ss2i-digital.fr";

function fakeGraph(value: unknown[]) {
	const fetchImpl = (async (url: string) => {
		if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
		return new Response(JSON.stringify({ value }), { status: 200 });
	}) as typeof fetch;
	return { tenant: `t-guests-${Math.random()}`, clientId: "c", clientSecret: "s", fetchImpl };
}

// Forme relevee par Graph sur l'agenda de Samuel le 24/11/2026.
const bastion = {
	id: "b1",
	subject: "[SS2i Services - Groupe LIBAUD] Présentation BASTION",
	start: { dateTime: "2026-11-24T11:30:00", timeZone: "Europe/Paris" },
	end: { dateTime: "2026-11-24T12:00:00", timeZone: "Europe/Paris" },
	location: { displayName: "" },
	onlineMeeting: null,
	isOnlineMeeting: false,
	isOrganizer: false,
	organizer: { emailAddress: { name: "Christophe SAUVION", address: "christophe.sauvion@ss2i-services.fr" } },
	attendees: [
		{ type: "required", status: { response: "accepted" }, emailAddress: { name: "Samuel Legros", address: "Samuel@ss2i-digital.fr" } },
		{ type: "required", status: { response: "none" }, emailAddress: { name: "n.dartois@groupe-libaud.fr", address: "n.dartois@groupe-libaud.fr" } },
	],
};

const perso = {
	id: "p1",
	subject: "envoi factures nathalie",
	start: { dateTime: "2026-11-24T09:00:00", timeZone: "Europe/Paris" },
	end: { dateTime: "2026-11-24T09:30:00", timeZone: "Europe/Paris" },
	isOrganizer: true,
	organizer: { emailAddress: { name: "Samuel Legros", address: ME } },
	attendees: [],
};

(async () => {
	await test("invitation recue : organisateur et autres invites, moi exclu (casse ignoree)", () => {
		const g = meetingGuests(bastion, ME);
		assert.deepEqual(
			g.map((x) => x.address),
			["christophe.sauvion@ss2i-services.fr", "n.dartois@groupe-libaud.fr"],
		);
		assert.equal(g[0].name, "Christophe SAUVION");
		assert.equal(g[1].name, undefined, "un nom egal a l'adresse ne sert a rien");
	});

	await test("entree perso : aucun invite", () => {
		assert.deepEqual(meetingGuests(perso, ME), []);
		assert.deepEqual(meetingGuests({ isOrganizer: true }, ME), []);
	});

	await test("salle (resource) et doublons ecartes", () => {
		const g = meetingGuests(
			{
				...perso,
				attendees: [
					{ type: "resource", emailAddress: { name: "Salle de réunion", address: "salle@ss2i-services.fr" } },
					{ type: "required", emailAddress: { name: "JB", address: "jb@ss2i-digital.fr" } },
					{ type: "optional", emailAddress: { name: "JB", address: "JB@ss2i-digital.fr" } },
					{ type: "required", emailAddress: { name: "", address: "" } },
				],
			},
			ME,
		);
		assert.deepEqual(g, [{ address: "jb@ss2i-digital.fr", name: "JB" }]);
	});

	await test("bonshommes : un par invite jusqu'a 5, au-dela 4 et « +N »", () => {
		assert.deepEqual(guestBuddies(0), { shown: 0, more: 0 });
		assert.deepEqual(guestBuddies(2), { shown: 2, more: 0 });
		assert.deepEqual(guestBuddies(5), { shown: 5, more: 0 });
		assert.deepEqual(guestBuddies(6), { shown: 4, more: 2 });
		assert.deepEqual(guestBuddies(30), { shown: 4, more: 26 });
	});

	await test("liste de l'agenda : invites portes par l'evenement", async () => {
		const list = await listCalendarEvents(fakeGraph([bastion, perso]), ME, undefined, "2026-11-24", "2026-11-25");
		const b = list.find((e) => e.id === "b1");
		const p = list.find((e) => e.id === "p1");
		assert.equal(b?.guests?.length, 2);
		assert.equal(p?.guests, undefined);
	});

	await test("cablage : grille, vue mois et infobulle montrent la reunion", () => {
		const grid = src("apps/web/components/outlook-calendar/calendar-grid.tsx");
		assert.match(grid, /data-meeting/);
		assert.match(grid, /<MeetingBadge/);
		assert.match(grid, /guestBuddies\(/);
		assert.match(grid, /Avec : /);
		const month = src("apps/web/components/outlook-calendar/month-grid.tsx");
		assert.match(month, /data-meeting/);
	});

	if (failed) {
		console.error(`\n${failed} test(s) en echec`);
		process.exit(1);
	}
	console.log("\ntous les tests passent");
})();
