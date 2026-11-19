"use client";
// ss2i : encart « agenda du jour » en haut d'une invitation (Samuel le 19/11/2026 : « j'ai envie
// de voir directement au-dessus du mail, dans un petit encart, a quel endroit sur le calendrier
// ca va se positionner l'invitation en question. Histoire que je vois s'il y a des conflits, des
// trucs juste avant, juste apres [...] Sans avoir a aller sur le calendrier en lui-meme et perdre
// le contexte. Eventuellement, un bouton pour aller sur le calendrier »). Le jour de l'invitation
// (heure de Paris) en lecture seule, centre sur elle, l'invitation en evenement plein au milieu
// des rendez-vous Outlook, une ligne de synthese des conflits et un lien vers la page agenda.
// Rien n'est affiche pour une identite sans Outlook, une erreur de lecture ou une invitation sans
// date. Aucune creation ni deplacement depuis l'encart : un doigt qui defile ne declenche rien.
import React, { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CalendarDays } from "lucide-react";
import CalendarGrid from "@/components/outlook-calendar/calendar-grid";
import { useOutlookEvents } from "@/components/outlook-calendar/use-outlook-events";
import { useK } from "@/components/k/ui-context";
import { agendaUrl, conflictLabel, inviteConflicts, invitePreviewEvents, inviteScrollMinutes, inviteSlot, type InviteSource } from "@/lib/invite-preview";

export default function InviteDayPreview({ calendarEvent, identityPublicId, nouvelle }: { calendarEvent: InviteSource; identityPublicId: string; nouvelle: boolean }) {
	const k = useK();
	const params = useParams() as { wPublicId?: string };
	const slot = useMemo(
		() => inviteSlot(calendarEvent),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[String(calendarEvent.startsAt), String(calendarEvent.endsAt), calendarEvent.isAllDay, calendarEvent.title],
	);
	const { events, loading, loaded, error } = useOutlookEvents(slot ? identityPublicId : undefined, slot?.day ?? "", 1);
	const shown = useMemo(() => (slot ? invitePreviewEvents(slot, events) : []), [slot, events]);
	const conflicts = useMemo(() => (slot ? inviteConflicts(slot, events) : []), [slot, events]);

	if (!slot || error) return null;

	const allDay = k("All day", "Journée entière");
	const muted = nouvelle ? "text-k-ink-3" : "text-neutral-500 dark:text-neutral-400";
	const line = nouvelle ? "border-k-line" : "border-neutral-200/70 dark:border-neutral-800";

	return (
		<div className={`border-b ${line}`}>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-xs">
				<div className={`min-w-0 break-words ${!loaded ? muted : conflicts.length ? "font-medium text-red-700 dark:text-red-400" : muted}`}>
					{!loaded
						? k("Reading your calendar...", "Lecture de votre agenda...")
						: conflicts.length
							? `${k("Conflicts with: ", "En conflit avec : ")}${conflicts.map((c) => conflictLabel(c, allDay)).join(", ")}`
							: k("No conflict", "Aucun conflit")}
				</div>
				{params.wPublicId ? (
					<Link
						href={agendaUrl(params.wPublicId, slot.day, identityPublicId)}
						prefetch={false}
						className={`inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:underline ${nouvelle ? "text-k-accent" : "text-brand-700 dark:text-brand-300"}`}
					>
						<CalendarDays size={13} />
						{k("Open in calendar", "Ouvrir dans l'agenda")}
					</Link>
				) : null}
			</div>
			<div className={`flex h-[220px] min-h-0 flex-col border-t ${line}`}>
				<CalendarGrid
					className="flex-1"
					days={[slot.day]}
					events={shown}
					nouvelle={nouvelle}
					hourHeight={36}
					loading={loading || !loaded}
					scrollTo={inviteScrollMinutes(slot)}
					scrollKey={`${slot.day}|${slot.start}`}
				/>
			</div>
		</div>
	);
}
