// Lien de visio d'un evenement d'agenda (Samuel le 19/11/2026 : « quand on a une invitation google
// meet il faut afficher un bouton d'ouverture pour que sur tel ce soit fluide et sur fixe aussi »).
// Graph ne remplit onlineMeeting que pour Teams : une invitation Google Meet recue dans Outlook a
// onlineMeeting = null, le lien est dans le lieu (« https://meet.google.com/abc-defg-hij », ou
// « Google Meet (https://...) ou tel. ... ») et dans le corps (« Participer avec Google Meet »).
// Pur : aucun reseau.

export type MeetingProvider = "teams" | "meet" | "zoom";

const MEET = /(?:https?:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z])/i;
const TEAMS = /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)]+/i;
const ZOOM = /https:\/\/(?:[\w-]+\.)*zoom\.us\/(?:j|my|w)\/[^\s"'<>)]+/i;

/** Fournisseur d'un lien de visio, ou null. */
export function meetingProvider(url: string | undefined | null): MeetingProvider | null {
	const u = String(url ?? "");
	if (/^https:\/\/teams\.(microsoft|live)\.com\//i.test(u)) return "teams";
	if (/^https:\/\/meet\.google\.com\//i.test(u)) return "meet";
	if (/^https:\/\/([\w-]+\.)*zoom\.us\//i.test(u)) return "zoom";
	return null;
}

/** Nom affiche du fournisseur (« Google Meet », « Teams », « Zoom »). */
export function meetingLabel(url: string | undefined | null): string {
	const p = meetingProvider(url);
	return p === "meet" ? "Google Meet" : p === "teams" ? "Teams" : p === "zoom" ? "Zoom" : "visio";
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?38;/g, "&");

/** Premier lien de visio trouve dans ces textes, dans l'ordre (lien Meet ramene a sa forme courte). */
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

/** Lien pour rejoindre un evenement Graph brut : Teams natif d'abord, puis lieu, apercu et corps. */
export function graphJoinUrl(raw: any): string | undefined {
	const native = raw?.onlineMeeting?.joinUrl || raw?.onlineMeetingUrl;
	if (native) return String(native);
	const locations = Array.isArray(raw?.locations) ? raw.locations.flatMap((l: any) => [l?.locationUri, l?.displayName]) : [];
	return findMeetingUrl(raw?.location?.locationUri, raw?.location?.displayName, ...locations, raw?.bodyPreview, raw?.body?.content);
}

/** Le lieu n'est que le lien de visio (rien d'autre a afficher). */
export function locationIsJustLink(location: string | undefined | null, joinUrl: string | undefined | null): boolean {
	const l = String(location ?? "").trim();
	if (!l || !joinUrl) return false;
	return /^\S+$/.test(l) && findMeetingUrl(l) === findMeetingUrl(joinUrl);
}
