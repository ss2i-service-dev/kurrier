// "Join" button on an invitation card for Google Meet, Teams and Zoom meetings. The link is
// read from the location or the description of the event.
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/meeting-link.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findMeetingUrl, locationIsJustLink, meetingLabel, meetingProvider } from "../lib/meeting-link";

const web = join(__dirname, "..");
const source = (path: string) => readFileSync(join(web, path), "utf8");

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

test("Meet link: alone, with text around, without scheme, in HTML with ?hs=", () => {
	assert.equal(findMeetingUrl("https://meet.google.com/ujp-abjc-ktw"), "https://meet.google.com/ujp-abjc-ktw");
	assert.equal(
		findMeetingUrl("Google Meet (https://meet.google.com/ujp-abjc-ktw?hs=224) or tel. +1 234 567 890, PIN 824058506"),
		"https://meet.google.com/ujp-abjc-ktw",
	);
	assert.equal(findMeetingUrl("Join with Google Meet / meet.google.com/kcb-iqqs-zro / "), "https://meet.google.com/kcb-iqqs-zro");
	assert.equal(findMeetingUrl('<a href="https://meet.google.com/uez-qcvs-dwt?hs=224">Join</a>'), "https://meet.google.com/uez-qcvs-dwt");
	assert.equal(findMeetingUrl("https://meet.google.com/landing"), undefined);
	assert.equal(findMeetingUrl("Atlantic room", "", undefined), undefined);
});

test("Teams and Zoom (&amp; decoded), provider and label", () => {
	const teams = findMeetingUrl('<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&amp;anon=true">Join</a>');
	assert.equal(teams, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&anon=true");
	assert.equal(findMeetingUrl("Zoom: https://us02web.zoom.us/j/8123456789?pwd=abc.1 ID"), "https://us02web.zoom.us/j/8123456789?pwd=abc.1");
	assert.equal(meetingProvider("https://meet.google.com/ujp-abjc-ktw"), "meet");
	assert.equal(meetingProvider(teams), "teams");
	assert.equal(meetingProvider("https://us02web.zoom.us/j/1"), "zoom");
	assert.equal(meetingProvider("https://example.com"), null);
	assert.equal(meetingLabel("https://meet.google.com/ujp-abjc-ktw"), "Google Meet");
	assert.equal(meetingLabel(teams), "Teams");
});

test("first text wins: the location before the description", () => {
	assert.equal(
		findMeetingUrl("https://meet.google.com/aaa-bbbb-ccc", "https://meet.google.com/ddd-eeee-fff"),
		"https://meet.google.com/aaa-bbbb-ccc",
	);
	assert.equal(findMeetingUrl("Room 4", "Join: https://meet.google.com/ddd-eeee-fff"), "https://meet.google.com/ddd-eeee-fff");
});

test("location reduced to the link: hidden; with a phone number: kept", () => {
	const url = "https://meet.google.com/ujp-abjc-ktw";
	assert.equal(locationIsJustLink(url, url), true);
	assert.equal(locationIsJustLink("Google Meet (https://meet.google.com/ujp-abjc-ktw?hs=224) or tel. +1 234 567 890", url), false);
	assert.equal(locationIsJustLink("Office", undefined), false);
});

test("invitation card: button per provider, location hidden when it is only the link", () => {
	const card = source("components/mailbox/default/render-invite.tsx");
	assert.match(card, /findMeetingUrl\(calendarEvent\.location, calendarEvent\.description\)/);
	assert.match(card, /openMeeting\(ev, joinUrl\)/);
	assert.match(card, /locationIsJustLink\(calendarEvent\.location, joinUrl\)/);
	assert.match(card, /meetingLabel\(joinUrl\)/);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
