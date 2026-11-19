// ss2i : texte d'un evenement de l'agenda pour le presse-papiers (Samuel le 10/11 : « un
// bouton copier toutes les informations de cet evenement [...] pour pouvoir envoyer ca par
// exemple dans une conversation Claude »). Pur : les notes arrivent deja en texte (htmlToText
// de lib/mail-copy, cote navigateur). Test : apps/web/test/event-copy.ts.
import { agendaWhen } from "../../../packages/common/src/thread-agenda";
import { meetingLabel } from "../../../packages/common/src/meeting-link";
import type { Attendee, AttendeeResponse, EventAttachment } from "../../../packages/common/src/outlook-graph";

export type CopyableEvent = {
	title: string;
	allDay: boolean;
	start: string;
	end: string;
	location?: string;
	webLink?: string;
	organizer?: string;
	organizerAddress?: string;
	attendees?: Attendee[];
	joinUrl?: string;
	recurrenceLabel?: string;
	categories?: string[];
	room?: { address: string; name: string };
	isPrivate?: boolean;
	attachments?: EventAttachment[];
};

const RESPONSE: Record<AttendeeResponse, string> = {
	accepted: "Accepté",
	tentativelyAccepted: "Provisoire",
	declined: "Refusé",
	organizer: "Organisateur",
	none: "Pas de réponse",
	notResponded: "Pas de réponse",
};

const person = (name: string | undefined, address: string | undefined) =>
	name && address && name !== address ? `${name} <${address}>` : (address ?? name ?? "");

export function formatEventForCopy(e: CopyableEvent, opts: { notes?: string; calendarName?: string } = {}): string {
	const lines: string[] = [`Événement : ${e.title || "(sans titre)"}`, `Quand : ${agendaWhen({ ...e, sourceQuote: "" })}`];
	if (e.recurrenceLabel) lines.push(`Répétition : ${e.recurrenceLabel}`);
	if (e.location?.trim()) lines.push(`Lieu : ${e.location.trim()}`);
	if (e.room && e.room.name !== e.location?.trim()) lines.push(`Salle : ${e.room.name}`);
	if (opts.calendarName) lines.push(`Agenda : ${opts.calendarName}`);
	if (e.organizer || e.organizerAddress) lines.push(`Organisateur : ${person(e.organizer, e.organizerAddress)}`);
	const attendees = (e.attendees ?? []).filter((a) => a.address !== e.organizerAddress && a.address !== e.room?.address);
	if (attendees.length) {
		lines.push("Participants :");
		for (const a of attendees) {
			const opt = a.type === "optional" ? " (facultatif)" : "";
			lines.push(`- ${person(a.name, a.address)}${opt} : ${RESPONSE[a.response ?? "none"] ?? RESPONSE.none}`);
		}
	}
	if (e.joinUrl) lines.push(`Réunion ${meetingLabel(e.joinUrl)} : ${e.joinUrl}`);
	if (e.categories?.length) lines.push(`Catégories : ${e.categories.join(", ")}`);
	if (e.isPrivate) lines.push("Privé : oui");
	const files = (e.attachments ?? []).filter((a) => !a.isInline);
	if (files.length) lines.push(`Pièces jointes : ${files.map((a) => a.name).join(", ")}`);
	if (e.webLink) lines.push(`Lien Outlook : ${e.webLink}`);
	const notes = opts.notes?.trim();
	if (notes) lines.push("", "Notes :", notes);
	return lines.join("\n");
}
