"use client";

import React, { useMemo } from "react";
import { CalendarDays, Clock, MapPin, User, Video, CheckCircle, CircleDashed, CircleX } from "lucide-react";
import type { CalendarEventEntity, CalendarEventAttendeeEntity, IdentityEntity } from "@db";
import { ReusableFormButton } from "@/components/common/reusable-form-button";
import { maybeCalendarInvite, noCalendarInvite, yesCalendarInvite } from "@/lib/actions/calendar";
import { useModernUi } from "@/components/k/ui-context";
import { hourOptions } from "@/lib/hour-format";
import { findMeetingUrl, locationIsJustLink, meetingLabel, meetingProvider, openMeeting } from "@/lib/meeting-link";

type Props = {
    calendarEvent: CalendarEventEntity;
    attendees: CalendarEventAttendeeEntity[];
    identity: IdentityEntity;
    // Settings > Reading > times in 24-hour format (off: format of the locale).
    hour24?: boolean;
};

function fmtRange(startsAt: string, endsAt: string, hour24: boolean) {
    const start = new Date(startsAt);
    const end = new Date(endsAt);

    const fmtStart = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...hourOptions(hour24),
    });

    const fmtTime = new Intl.DateTimeFormat(undefined, hourOptions(hour24));

    const sameDay =
        start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth() &&
        start.getDate() === end.getDate();

    if (sameDay) return `${fmtStart.format(start)} – ${fmtTime.format(end)}`;
    return `${fmtStart.format(start)} – ${fmtStart.format(end)}`;
}

function partstatLabel(partstat: string | null | undefined) {
    const v = (partstat || "").toLowerCase();
    if (v === "needs_action") return "Awaiting your response";
    if (v === "accepted") return "You accepted";
    if (v === "declined") return "You declined";
    if (v === "tentative") return "You responded maybe";
    return null;
}

export default function RenderInvite({ calendarEvent, attendees, identity, hour24 = false }: Props) {
    const modern = useModernUi();
    const selfAttendee = useMemo(() => {
        const me = (identity.value || "").trim().toLowerCase();
        return attendees.find((a) => (a.email || "").trim().toLowerCase() === me) ?? null;
    }, [attendees, identity.value]);

    const when = calendarEvent.isAllDay
        ? "All day"
        : fmtRange(String(calendarEvent.startsAt), String(calendarEvent.endsAt), hour24);

    const organizer =
        calendarEvent.organizerName || calendarEvent.organizerEmail
            ? `${calendarEvent.organizerName || ""}${
                calendarEvent.organizerEmail
                    ? `${calendarEvent.organizerName ? " — " : ""}${calendarEvent.organizerEmail}`
                    : ""
            }`
            : null;

    // Link of the video meeting: in the location first, then in the description.
    const joinUrl = findMeetingUrl(calendarEvent.location, calendarEvent.description);

    const responseLabel = partstatLabel(selfAttendee?.partstat);
    const isPending = (selfAttendee?.partstat || "").toLowerCase() === "needs_action";

    const canRespond = !!selfAttendee?.id;

    const calendarId = String(calendarEvent.calendarId);
    const eventId = String(calendarEvent.id);
    const attendeeId = String(selfAttendee?.id || "");

    return (
        <div className={modern
            ? "my-4 overflow-hidden rounded-k border border-k-line bg-k-surface-2 text-k-ink"
            : "my-4 overflow-hidden rounded-2xl border border-neutral-200/70 bg-brand-100 dark:border-neutral-800 dark:bg-neutral-800"}>
            <div className={modern
                ? "flex items-start justify-between gap-4 bg-k-surface px-4 py-3"
                : "flex items-start justify-between gap-4 bg-neutral-50 px-4 py-3 dark:bg-neutral-900/40"}>
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-xs font-medium text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
              Invite
            </span>
                    </div>

                    <div className="mt-2 text-sm font-semibold text-neutral-500 dark:text-neutral-400">
                        Invitation
                    </div>

                    <div className="mt-1 truncate text-2xl font-extrabold text-neutral-900 dark:text-neutral-100">
                        {calendarEvent.title || "Invitation"}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600 dark:text-neutral-300">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={14} />
              <span>{when}</span>
            </span>
                    </div>

                    {organizer ? (
                        <div className="mt-2 flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                            <User size={14} />
                            <span className="truncate">
                {organizer} <span className="opacity-70">— Organizer</span>
              </span>
                        </div>
                    ) : null}

                    {joinUrl ? (
                        <a
                            href={joinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(ev) => openMeeting(ev, joinUrl)}
                            className={`mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 sm:px-2.5 sm:py-1 sm:text-[12.5px] ${meetingProvider(joinUrl) === "meet" ? "bg-[#1a73e8]" : "bg-[#5b5fc7]"}`}
                        >
                            <Video size={14} /> Join the {meetingLabel(joinUrl)} meeting
                        </a>
                    ) : null}

                    {calendarEvent.location && !locationIsJustLink(calendarEvent.location, joinUrl) ? (
                        <div className="mt-1 flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                            <MapPin size={14} />
                            <span className="truncate">{calendarEvent.location}</span>
                        </div>
                    ) : null}
                </div>

                <div className="shrink-0">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                        <CalendarDays size={22} />
                    </div>
                </div>
            </div>

            <div className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                    <ReusableFormButton
                        action={yesCalendarInvite}
                        label="Yes"
                        buttonProps={{
                            leftSection: <CheckCircle size={16} />,
                            size: "compact-xs",
                            variant: (selfAttendee?.partstat || "").toLowerCase() === "accepted" ? "filled" : "subtle",
                            tabIndex: -1,
                            disabled: !canRespond,
                        }}
                    >
                        <input type="hidden" name="calendarId" value={calendarId} />
                        <input type="hidden" name="eventId" value={eventId} />
                        <input type="hidden" name="attendeeId" value={attendeeId} />
                    </ReusableFormButton>

                    <ReusableFormButton
                        action={maybeCalendarInvite}
                        label="Maybe"
                        buttonProps={{
                            leftSection: <CircleDashed size={16} />,
                            size: "compact-xs",
                            variant: (selfAttendee?.partstat || "").toLowerCase() === "tentative" ? "filled" : "subtle",
                            tabIndex: -1,
                            disabled: !canRespond,
                        }}
                    >
                        <input type="hidden" name="calendarId" value={calendarId} />
                        <input type="hidden" name="eventId" value={eventId} />
                        <input type="hidden" name="attendeeId" value={attendeeId} />
                    </ReusableFormButton>

                    <ReusableFormButton
                        action={noCalendarInvite}
                        label="No"
                        buttonProps={{
                            leftSection: <CircleX size={16} />,
                            size: "compact-xs",
                            variant: (selfAttendee?.partstat || "").toLowerCase() === "declined" ? "filled" : "subtle",
                            tabIndex: -1,
                            disabled: !canRespond,
                        }}
                    >
                        <input type="hidden" name="calendarId" value={calendarId} />
                        <input type="hidden" name="eventId" value={eventId} />
                        <input type="hidden" name="attendeeId" value={attendeeId} />
                    </ReusableFormButton>
                </div>

                {responseLabel ? (
                    <div
                        className={[
                            "mt-2 text-xs",
                            isPending ? "text-neutral-500 dark:text-neutral-400" : "text-brand-600 dark:text-brand-400",
                        ].join(" ")}
                    >
                        {responseLabel}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
