// Times shown in 24-hour format (per-user option, off by default: the format of the locale of
// the browser applies, 12 h for most English locales). Pure logic, tested in test/hour-format.ts,
// shared by the invitation card and the settings.

/** Intl options for an hour: "13:30" when the option is on, the locale default otherwise. */
export function hourOptions(hour24: boolean): Pick<Intl.DateTimeFormatOptions, "hour" | "minute" | "hourCycle"> {
	return hour24 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "numeric", minute: "2-digit" };
}
