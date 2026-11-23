import { useHour24, useModernUi } from "@/components/k/ui-context";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, CalendarDays, ChevronDown, X } from "lucide-react";
import { Button, Popover } from "@mantine/core";
import { DatePicker } from "@mantine/dates";
import {
	formatScheduledWhen,
	parseScheduleText,
	parseTimeText,
	schedulePresets,
} from "@common/schedule-send";

// "Schedule send": a single popover anchored to the Send arrow, no modal nor time picker
// wheel: presets, free-text input ("tomorrow 9am", read by parseScheduleText), day chips,
// calendar and time. Times follow the "24-hour time" option (pref24HourTime).

const pad = (n: number) => String(n).padStart(2, "0");
const HOUR_CHIPS = [7, 8, 9, 10, 11, 12];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Civil date YYYY-MM-DD shifted by n days (computed in UTC: immune to clock changes).
function shiftYmd(ymd: string, days: number) {
	const [y, m, d] = ymd.split("-").map(Number);
	const u = new Date(Date.UTC(y, m - 1, d + days));
	return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

// Day and time (24-hour HH:MM) of a moment, in time zone tz.
function civilOf(at: Date, tz: string) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
			.formatToParts(at)
			.map((x) => [x.type, x.value]),
	) as Record<string, string>;
	return { ymd: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// A time as typed in the time field: "09:30" (24-hour time) or "9:30 AM".
function timeText(t: { h: number; m: number }, hour24: boolean) {
	if (hour24) return `${pad(t.h)}:${pad(t.m)}`;
	return `${t.h % 12 || 12}:${pad(t.m)} ${t.h < 12 ? "AM" : "PM"}`;
}

// Free-text input equivalent to a day (YYYY-MM-DD, or null) and a time: "Nov 13 9:30 AM".
function composeText(ymd: string | null, t: { h: number; m: number }, thisYear: string, hour24: boolean) {
	const time = timeText(t, hour24);
	if (!ymd) return time;
	const [y, m, d] = ymd.split("-");
	return `${MONTHS[Number(m) - 1]} ${Number(d)}${y === thisYear ? "" : ` ${y}`} ${time}`;
}

const hmOf = (time: string) => {
	const [h, m] = time.split(":").map(Number);
	return { h, m };
};

type Props = {
	// Short label of the scheduled moment, null once cleared: shown on the Send button.
	onLabelChange?: (label: string | null) => void;
};

function ScheduleSend({ onLabelChange }: Props) {
	const modern = useModernUi();
	const hour24 = useHour24();
	const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
	const [opened, setOpened] = useState(false);
	const [text, setText] = useState("");
	const [timeField, setTimeField] = useState("");
	const [calendar, setCalendar] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	// Weekday and time, in the time zone of the browser.
	const formatWhen = (d: Date) => formatScheduledWhen(d, localTz, new Date(), hour24);

	useEffect(() => {
		onLabelChange?.(scheduledAt ? formatWhen(scheduledAt) : null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scheduledAt, hour24]);

	// Escape closes the popover without closing the editor (which closes on Escape): capture phase.
	useEffect(() => {
		if (!opened) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpened(false);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [opened]);

	const now = new Date();
	const todayYmd = civilOf(now, localTz).ymd;
	const thisYear = todayYmd.slice(0, 4);
	const parsed = useMemo(() => parseScheduleText(text, new Date(), localTz), [text, localTz, opened]);
	const parsedCivil = parsed.ok ? civilOf(parsed.at, localTz) : null;

	const openPopover = () => {
		if (scheduledAt) {
			const c = civilOf(scheduledAt, localTz);
			setText(composeText(c.ymd, hmOf(c.time), thisYear, hour24));
			setTimeField(timeText(hmOf(c.time), hour24));
		} else {
			setText("");
			setTimeField("");
		}
		setCalendar(false);
		setOpened(true);
	};

	const apply = (at: Date) => {
		setScheduledAt(at);
		setOpened(false);
	};
	const submit = () => {
		if (parsed.ok) apply(parsed.at);
	};

	const onText = (v: string) => {
		setText(v);
		const r = parseScheduleText(v, new Date(), localTz);
		if (r.ok) setTimeField(timeText(hmOf(civilOf(r.at, localTz).time), hour24));
	};
	const pickDay = (ymd: string) => {
		const tm = parseTimeText(timeField) ?? { h: 8, m: 0 };
		setTimeField(timeText(tm, hour24));
		setText(composeText(ymd, tm, thisYear, hour24));
	};
	const editTime = (v: string) => {
		setTimeField(v);
		const tm = parseTimeText(v);
		if (!tm) return;
		// The day already chosen is kept; without a day, the time alone means today or tomorrow.
		setText(composeText(parsedCivil?.ymd ?? null, tm, thisYear, hour24));
	};

	const presets = schedulePresets(now, localTz, hour24);
	const days = Array.from({ length: 7 }, (_, i) => {
		const ymd = shiftYmd(todayYmd, i);
		const [y, m, d] = ymd.split("-").map(Number);
		const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
			new Date(Date.UTC(y, m - 1, d)),
		);
		const label = i === 0 ? "Today" : i === 1 ? "Tom." : `${wd} ${d}`;
		return { ymd, label };
	});
	const timeValid = timeField === "" || !!parseTimeText(timeField);

	// Styles: k- tokens in the three-column interface, Tailwind classes otherwise (light and dark).
	const cls = modern
		? {
				drop: "!border-k-line-strong !bg-k-surface !text-k-ink !rounded-k !p-3",
				title: "text-[14px] font-semibold text-k-ink",
				row: "k-focus flex w-full items-center justify-between gap-4 rounded-k-sm px-2 py-1.5 text-left text-[13px] text-k-ink hover:bg-k-hover",
				muted: "text-[12px] text-k-ink-3",
				label: "mt-3 mb-1 text-[12px] font-medium text-k-ink-2",
				input: "k-focus w-full rounded-k-sm border border-k-line-strong bg-k-surface px-2 py-1.5 text-[13px] text-k-ink placeholder:text-k-ink-3",
				chip: "k-focus rounded-k-sm border border-k-line-strong px-2 py-1 text-[12px] text-k-ink-2 hover:bg-k-hover",
				chipOn: "k-focus rounded-k-sm border border-k-accent bg-k-accent-soft px-2 py-1 text-[12px] font-medium text-k-accent-soft-ink",
				ok: "text-[12px] text-k-ink-2",
				bad: "text-[12px] text-k-danger",
				line: "border-k-line",
			}
		: {
				drop: "!p-3",
				title: "text-base font-semibold",
				row: "flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-neutral-700",
				muted: "text-xs text-neutral-500",
				label: "mt-3 mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-300",
				input: "w-full rounded border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-600",
				chip: "rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-neutral-600 dark:hover:bg-neutral-700",
				chipOn: "rounded border border-blue-500 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300",
				ok: "text-xs text-neutral-700 dark:text-neutral-300",
				bad: "text-xs text-red-600",
				line: "border-gray-200 dark:border-neutral-700",
			};

	const scheduled = !!scheduledAt;

	return (
		<>
			<input type="hidden" name="scheduledSend" value={scheduled ? "yes" : "no"} />
			{scheduledAt ? <input type="hidden" name="scheduledAt" value={scheduledAt.toISOString()} /> : null}

			<Popover
				opened={opened}
				onChange={setOpened}
				position="top-start"
				shadow="xl"
				width={340}
				zIndex={1005}
				trapFocus
				returnFocus
				closeOnEscape={false}
			>
				<Popover.Target>
					<Button
						type="button"
						size="sm"
						className="!px-2 !rounded-l-xs !rounded-r-4xl"
						title={scheduled ? `Scheduled · ${formatWhen(scheduledAt!)}` : "Schedule Send"}
						aria-label="Schedule Send"
						aria-haspopup="dialog"
						aria-expanded={opened}
						onClick={() => (opened ? setOpened(false) : openPopover())}
					>
						{scheduled ? <CalendarClock size={14} /> : <ChevronDown size={14} />}
					</Button>
				</Popover.Target>

				<Popover.Dropdown className={cls.drop} role="dialog" aria-label="Schedule Send">
					<div className="flex items-center justify-between gap-2">
						<div className={cls.title}>Schedule Send</div>
						{scheduled ? (
							<button
								type="button"
								className={`${cls.muted} inline-flex items-center gap-1 hover:underline`}
								onClick={() => {
									setScheduledAt(null);
									setOpened(false);
								}}
							>
								<X size={12} aria-hidden />
								Remove schedule
							</button>
						) : null}
					</div>

					<div className="mt-2">
						{presets.map((p) => (
							<button key={p.key} type="button" className={cls.row} onClick={() => apply(p.date)}>
								<span>{p.label}</span>
								<span className={cls.muted}>{formatWhen(p.date)}</span>
							</button>
						))}
					</div>

					<div className={`mt-3 border-t pt-1 ${cls.line}`}>
						<div className={cls.label}>Other time</div>
						<input
							ref={inputRef}
							data-autofocus
							className={cls.input}
							value={text}
							placeholder="tomorrow 9:30am, monday 8am, in 2h, nov 13 10am"
							aria-label="Other time"
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => onText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									e.stopPropagation();
									submit();
								}
							}}
						/>
						<div className="mt-1 min-h-[18px]" aria-live="polite">
							{parsed.ok ? (
								<span className={cls.ok}>-&gt; {formatWhen(parsed.at)}</span>
							) : parsed.reason === "empty" ? null : (
								<span className={cls.bad}>
									{parsed.reason === "past" ? "Time already passed" : "I don't understand"}
								</span>
							)}
						</div>
					</div>

					<div className="mt-2 flex flex-wrap items-center gap-1">
						{days.map((d) => (
							<button
								key={d.ymd}
								type="button"
								className={parsedCivil?.ymd === d.ymd ? cls.chipOn : cls.chip}
								onClick={() => pickDay(d.ymd)}
							>
								{d.label}
							</button>
						))}
						<button
							type="button"
							className={calendar ? cls.chipOn : cls.chip}
							title="Pick a date"
							aria-label="Pick a date"
							aria-pressed={calendar}
							onClick={() => setCalendar((c) => !c)}
						>
							<CalendarDays size={14} aria-hidden />
						</button>
					</div>

					{calendar ? (
						<div className="mt-2 flex justify-center">
							<DatePicker
								size="xs"
								minDate={todayYmd}
								value={parsedCivil?.ymd ?? null}
								onChange={(v) => v && pickDay(v)}
							/>
						</div>
					) : null}

					<div className="mt-2 flex flex-wrap items-center gap-1">
						<input
							className={`${cls.input} ${hour24 ? "!w-[78px]" : "!w-[96px]"} text-center ${timeValid ? "" : "!border-red-500"}`}
							value={timeField}
							placeholder={hour24 ? "HH:MM" : "h:mm AM"}
							aria-label="Time"
							inputMode={hour24 ? "numeric" : "text"}
							autoComplete="off"
							onChange={(e) => editTime(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									e.stopPropagation();
									submit();
								}
							}}
						/>
						{HOUR_CHIPS.map((h) => (
							<button
								key={h}
								type="button"
								className={parsedCivil?.time === `${pad(h)}:00` ? cls.chipOn : cls.chip}
								onClick={() => editTime(timeText({ h, m: 0 }, hour24))}
							>
								{hour24 ? `${pad(h)}:00` : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`}
							</button>
						))}
					</div>

					<Button type="button" fullWidth size="xs" className="!mt-3" disabled={!parsed.ok} onClick={submit}>
						Schedule
					</Button>
				</Popover.Dropdown>
			</Popover>
		</>
	);
}

export default ScheduleSend;
