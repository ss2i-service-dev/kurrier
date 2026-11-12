import { useK, useNouvelle } from "@/components/k/ui-context";
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

// ss2i : « Programmer l'envoi » (Samuel le 12/11 : « le time picker c'est un cauchemar », « le PM,
// AM, ça me plaît pas du tout. Nous on parle de midi à minuit »). Une seule fenetre ancree a la
// fleche d'Envoyer, sans modal ni selecteur Mantine d'heure : raccourcis, saisie libre (« demain
// 9h », comprise par parseScheduleText), puces de jours, calendrier et heure en 24 h.

const pad = (n: number) => String(n).padStart(2, "0");
const HOUR_CHIPS = [7, 8, 9, 10, 11, 12];

// Date civile AAAA-MM-JJ decalee de n jours (calcul UTC : insensible aux changements d'heure).
function shiftYmd(ymd: string, days: number) {
	const [y, m, d] = ymd.split("-").map(Number);
	const u = new Date(Date.UTC(y, m - 1, d + days));
	return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

// Jour et heure d'un instant, dans le fuseau tz.
function civilOf(at: Date, tz: string) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
			.formatToParts(at)
			.map((x) => [x.type, x.value]),
	) as Record<string, string>;
	return { ymd: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Texte de saisie libre equivalent a un jour (AAAA-MM-JJ, ou null) et une heure : « 13/11 09:30 ».
function composeText(ymd: string | null, time: string, thisYear: string) {
	if (!ymd) return time;
	const [y, m, d] = ymd.split("-");
	return `${d}/${m}${y === thisYear ? "" : `/${y}`} ${time}`;
}

type Props = {
	// Libelle court du moment programme (« ven. 13/11 08:00 »), null une fois efface : sert au bouton Envoyer.
	onLabelChange?: (label: string | null) => void;
};

function ScheduleSend({ onLabelChange }: Props) {
	const t = useK(); // ss2i : francais dans la nouvelle interface
	const nouvelle = useNouvelle();
	const lang = t("en", "fr") as "en" | "fr";
	const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
	const [opened, setOpened] = useState(false);
	const [text, setText] = useState("");
	const [timeField, setTimeField] = useState("");
	const [calendar, setCalendar] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	// 24 h, jour de la semaine : « ven. 13/11 à 08:00 » (fuseau du navigateur).
	const formatWhen = (d: Date) => formatScheduledWhen(d, lang, localTz);
	const shortWhen = (d: Date) => formatWhen(d).replace(" à ", " ");

	useEffect(() => {
		onLabelChange?.(scheduledAt ? shortWhen(scheduledAt) : null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scheduledAt]);

	// Echap ferme la fenetre sans fermer l'editeur (qui se ferme sur Echap) : ecoute en capture.
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
			setText(composeText(c.ymd, c.time, thisYear));
			setTimeField(c.time);
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
		if (r.ok) setTimeField(civilOf(r.at, localTz).time);
	};
	const pickDay = (ymd: string) => {
		const tm = parseTimeText(timeField);
		const time = tm ? `${pad(tm.h)}:${pad(tm.m)}` : "08:00";
		setTimeField(time);
		setText(composeText(ymd, time, thisYear));
	};
	const editTime = (v: string) => {
		setTimeField(v);
		const tm = parseTimeText(v);
		if (!tm) return;
		const time = `${pad(tm.h)}:${pad(tm.m)}`;
		// Le jour deja choisi est conserve ; sans jour, l'heure seule vaut aujourd'hui ou demain.
		setText(composeText(parsedCivil?.ymd ?? null, time, thisYear));
	};

	const presets = schedulePresets(now, localTz);
	const days = Array.from({ length: 7 }, (_, i) => {
		const ymd = shiftYmd(todayYmd, i);
		const [y, m, d] = ymd.split("-").map(Number);
		const wd = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { weekday: "short", timeZone: "UTC" })
			.format(new Date(Date.UTC(y, m - 1, d)))
			.replace(/\.$/, "");
		const label =
			i === 0 ? t("Today", "Auj.") : i === 1 ? t("Tom.", "Dem.") : `${wd}${lang === "fr" ? "." : ""} ${d}`;
		return { ymd, label };
	});
	const timeValid = timeField === "" || !!parseTimeText(timeField);

	// Styles : jetons k- de la nouvelle interface, classes Tailwind sinon (themes clair et sombre).
	const cls = nouvelle
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
						title={scheduled ? `${t("Scheduled", "Programmé")} · ${formatWhen(scheduledAt!)}` : t("Schedule Send", "Programmer l'envoi")}
						aria-label={t("Schedule Send", "Programmer l'envoi")}
						aria-haspopup="dialog"
						aria-expanded={opened}
						onClick={() => (opened ? setOpened(false) : openPopover())}
					>
						{scheduled ? <CalendarClock size={14} /> : <ChevronDown size={14} />}
					</Button>
				</Popover.Target>

				<Popover.Dropdown className={cls.drop} role="dialog" aria-label={t("Schedule Send", "Programmer l'envoi")}>
					<div className="flex items-center justify-between gap-2">
						<div className={cls.title}>{t("Schedule Send", "Programmer l'envoi")}</div>
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
								{t("Remove schedule", "Annuler la programmation")}
							</button>
						) : null}
					</div>

					<div className="mt-2">
						{presets.map((p) => (
							<button key={p.key} type="button" className={cls.row} onClick={() => apply(p.date)}>
								<span>{lang === "fr" ? p.labelFr : p.labelEn}</span>
								<span className={cls.muted}>{formatWhen(p.date)}</span>
							</button>
						))}
					</div>

					<div className={`mt-3 border-t pt-1 ${cls.line}`}>
						<div className={cls.label}>{t("Other time", "Autre moment")}</div>
						<input
							ref={inputRef}
							data-autofocus
							className={cls.input}
							value={text}
							placeholder="demain 9h30, lundi 8h, dans 2h, 13/11 10h"
							aria-label={t("Other time", "Autre moment")}
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
									{parsed.reason === "past"
										? t("Time already passed", "Heure déjà passée")
										: t("I don't understand", "Je ne comprends pas")}
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
							title={t("Pick a date", "Choisir une date")}
							aria-label={t("Pick a date", "Choisir une date")}
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
								locale="fr"
								firstDayOfWeek={1}
								minDate={todayYmd}
								value={parsedCivil?.ymd ?? null}
								onChange={(v) => v && pickDay(v)}
							/>
						</div>
					) : null}

					<div className="mt-2 flex flex-wrap items-center gap-1">
						<input
							className={`${cls.input} !w-[78px] text-center ${timeValid ? "" : "!border-red-500"}`}
							value={timeField}
							placeholder="HH:MM"
							aria-label={t("Time (24 h)", "Heure (24 h)")}
							inputMode="numeric"
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
								onClick={() => editTime(`${pad(h)}:00`)}
							>
								{h}h
							</button>
						))}
					</div>

					<Button type="button" fullWidth size="xs" className="!mt-3" disabled={!parsed.ok} onClick={submit}>
						{t("Schedule", "Programmer")}
					</Button>
				</Popover.Dropdown>
			</Popover>
		</>
	);
}

export default ScheduleSend;
