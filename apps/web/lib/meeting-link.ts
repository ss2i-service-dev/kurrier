// Video meeting link of an invitation. Google Meet, Teams and Zoom invitations carry the link
// in the location ("https://meet.google.com/abc-defg-hij", or "Google Meet (https://...) or tel.
// ...") or in the description ("Join with Google Meet"). Pure: no network.
import type { MouseEvent } from "react";

export type MeetingProvider = "teams" | "meet" | "zoom";

const MEET = /(?:https?:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z])/i;
const TEAMS = /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)]+/i;
const ZOOM = /https:\/\/(?:[\w-]+\.)*zoom\.us\/(?:j|my|w)\/[^\s"'<>)]+/i;

/** Provider of a meeting link, or null. */
export function meetingProvider(url: string | undefined | null): MeetingProvider | null {
	const u = String(url ?? "");
	if (/^https:\/\/teams\.(microsoft|live)\.com\//i.test(u)) return "teams";
	if (/^https:\/\/meet\.google\.com\//i.test(u)) return "meet";
	if (/^https:\/\/([\w-]+\.)*zoom\.us\//i.test(u)) return "zoom";
	return null;
}

/** Display name of the provider ("Google Meet", "Teams", "Zoom"). */
export function meetingLabel(url: string | undefined | null): string {
	const p = meetingProvider(url);
	return p === "meet" ? "Google Meet" : p === "teams" ? "Teams" : p === "zoom" ? "Zoom" : "meeting";
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?38;/g, "&");

/** First meeting link found in these texts, in order (a Meet link is reduced to its short form). */
export function findMeetingUrl(...texts: Array<string | undefined | null>): string | undefined {
	for (const t of texts) {
		const s = String(t ?? "");
		if (!s) continue;
		const meet = s.match(MEET);
		if (meet) return `https://meet.google.com/${meet[1].toLowerCase()}`;
		const teams = s.match(TEAMS);
		if (teams) return unescapeHtml(teams[0]);
		const zoom = s.match(ZOOM);
		if (zoom) return unescapeHtml(zoom[0]);
	}
	return undefined;
}

/** The location is only the meeting link: nothing else to show. */
export function locationIsJustLink(location: string | undefined | null, joinUrl: string | undefined | null): boolean {
	const l = String(location ?? "").trim();
	if (!l || !joinUrl) return false;
	return /^\S+$/.test(l) && findMeetingUrl(l) === findMeetingUrl(joinUrl);
}

// Opening on a phone (coarse pointer): navigate in the tab itself so that Android and iOS hand
// over to the Meet or Teams app; target="_blank" can prevent that hand-over from Chrome Android
// and an installed PWA. On a desktop the link keeps its new tab.
export function openMeeting(e: MouseEvent<HTMLAnchorElement>, url: string): void {
	if (typeof window === "undefined" || !window.matchMedia?.("(pointer: coarse)").matches) return;
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	e.preventDefault();
	window.location.assign(url);
}
