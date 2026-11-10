// Copier toutes les informations d'un evenement de l'agenda (Samuel le 10/11 : « un bouton
// copier toutes les informations de cet evenement a cote du bouton editer et corbeille [...]
// pour pouvoir envoyer ca par exemple dans une conversation Claude »).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/event-copy.ts
import assert from "node:assert/strict";
import { formatEventForCopy } from "../lib/event-copy";

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

const base = {
	title: "Point projet Antellia",
	allDay: false,
	start: "2026-11-12T09:00",
	end: "2026-11-12T10:00",
};

test("evenement minimal : titre et horaire", () => {
	const t = formatEventForCopy(base);
	assert.match(t, /^Événement : Point projet Antellia$/m);
	assert.match(t, /^Quand : .*12.*novembre 2026.*9.*10/m);
	assert.doesNotMatch(t, /Lieu|Participants|Notes|Teams/);
});

test("toutes les informations du detail", () => {
	const t = formatEventForCopy(
		{
			...base,
			location: "Salle 2, La Rochelle",
			recurrenceLabel: "Toutes les semaines le jeudi",
			organizer: "Samuel LEGROS",
			organizerAddress: "samuel@ss2i-digital.fr",
			attendees: [
				{ address: "samuel@ss2i-digital.fr", name: "Samuel LEGROS", type: "required", response: "organizer" },
				{ address: "jb@ss2i-digital.fr", name: "JB", type: "required", response: "accepted" },
				{ address: "client@exemple.fr", type: "optional", response: "notResponded" },
			],
			joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
			categories: ["Client"],
			webLink: "https://outlook.office365.com/owa/?itemid=xyz",
			attachments: [{ id: "1", name: "ordre-du-jour.pdf", size: 1000, contentType: "application/pdf", isInline: false }],
		},
		{ notes: "Ordre du jour :\n- planning\n- budget", calendarName: "Calendrier de Samuel" },
	);
	assert.match(t, /^Lieu : Salle 2, La Rochelle$/m);
	assert.match(t, /^Répétition : Toutes les semaines le jeudi$/m);
	assert.match(t, /^Agenda : Calendrier de Samuel$/m);
	assert.match(t, /^Organisateur : Samuel LEGROS <samuel@ss2i-digital\.fr>$/m);
	assert.match(t, /^- JB <jb@ss2i-digital\.fr> : Accepté$/m);
	assert.match(t, /^- client@exemple\.fr \(facultatif\) : Pas de réponse$/m);
	assert.doesNotMatch(t, /^- Samuel LEGROS/m, "l'organisateur n'est pas repete dans les participants");
	assert.match(t, /^Réunion Teams : https:\/\/teams\.microsoft\.com\/l\/meetup-join\/abc$/m);
	assert.match(t, /^Catégories : Client$/m);
	assert.match(t, /^Pièces jointes : ordre-du-jour\.pdf$/m);
	assert.match(t, /^Lien Outlook : https:\/\/outlook/m);
	assert.match(t, /\nNotes :\nOrdre du jour :\n- planning\n- budget$/);
});

test("journee entiere et pieces jointes inline ignorees", () => {
	const t = formatEventForCopy({
		...base,
		allDay: true,
		start: "2026-12-07",
		end: "2026-12-11",
		attachments: [{ id: "1", name: "image001.png", size: 10, contentType: "image/png", isInline: true }],
	});
	assert.match(t, /^Quand : .*journée/m);
	assert.doesNotMatch(t, /Pièces jointes/);
});

test("salle reservee distincte du lieu, privee", () => {
	const t = formatEventForCopy({ ...base, location: "Visio", room: { address: "salle@x.fr", name: "Salle Atlantique" }, isPrivate: true });
	assert.match(t, /^Salle : Salle Atlantique$/m);
	assert.match(t, /^Privé : oui$/m);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nevent-copy : tous les tests passent");
