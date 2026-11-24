// ss2i : autres personnes d'une reunion Outlook (Samuel le 24/11/2026 : reperer dans l'agenda ce qui
// « depend de quelqu'un d'autre », avec un petit bonhomme par invite). Organisateur et participants
// (salles exclues, type resource), sans doublon, sans le titulaire de la boite. Liste vide : simple
// entree d'agenda.

export type MeetingGuest = { address: string; name?: string };

export function meetingGuests(raw: any, mailbox: string): MeetingGuest[] {
	const me = String(mailbox ?? "").trim().toLowerCase();
	const seen = new Set<string>(me ? [me] : []);
	const out: MeetingGuest[] = [];
	const add = (email: any) => {
		const address = String(email?.address ?? "").trim();
		const key = address.toLowerCase();
		if (!address || seen.has(key)) return;
		seen.add(key);
		const name = String(email?.name ?? "").trim();
		out.push(name && name.toLowerCase() !== key ? { address: key, name } : { address: key });
	};
	add(raw?.organizer?.emailAddress);
	for (const a of Array.isArray(raw?.attendees) ? raw.attendees : []) {
		if (a?.type === "resource") continue;
		add(a?.emailAddress);
	}
	return out;
}

/** Bonshommes a dessiner : un par invite jusqu'a 5 ; au-dela, 4 et « +N ». */
export function guestBuddies(count: number, max = 5): { shown: number; more: number } {
	const n = Math.max(0, Math.floor(count || 0));
	if (n <= max) return { shown: n, more: 0 };
	return { shown: max - 1, more: n - (max - 1) };
}
