"use client";
import React from "react";
import { Checkbox, NativeSelect, TextInput } from "@mantine/core";
import { ALL_DAY_REMINDERS, type AgendaEvent, TIMED_REMINDERS, agendaWhen, defaultReminders } from "@common/thread-agenda";

// ss2i : les deux etapes de « Ajouter a l'agenda » (OI 10280), sans etat ni appel serveur :
// propositions a corriger, puis recapitulatif de ce qui sera cree avec les rappels de chaque
// evenement : trois cases cochees d'emblee pour un horaire (1 h avant, 15 min avant, a l'heure),
// la veille a 8 h pour une journee entiere (Samuel, 19/11 : « on les decoche si on a envie »).
// Libelles en francais dans les deux interfaces.

/** timeToCheck : proposition sans heure dans le fil, 09:00 mise a sa place, a verifier. */
export type AgendaRow = AgendaEvent & { key: number; checked: boolean; error?: string; timeToCheck?: boolean };

const datePart = (v: string) => v.slice(0, 10);
const timePart = (v: string) => (v.length >= 16 ? v.slice(11, 16) : "");

const styles = (nouvelle: boolean) => ({
	muted: nouvelle ? "text-k-ink-3" : "text-muted-foreground",
	card: nouvelle ? "rounded-k-sm border border-k-line p-3" : "rounded-md border p-3",
});

const RowError = ({ error }: { error?: string }) =>
	error ? (
		<div className="text-xs text-red-700" role="alert">
			{error}
		</div>
	) : null;

/** Etape 1 : chaque proposition se corrige ou se decoche. */
export function ProposalsStep({
	rows,
	mailbox,
	nouvelle,
	onChange,
	activeKey = null,
	onActivate,
	planning = false,
}: {
	rows: AgendaRow[];
	mailbox: string;
	nouvelle: boolean;
	onChange: (key: number, patch: Partial<AgendaRow>) => void;
	/** Proposition placee par un clic dans l'agenda a cote (fenetre elargie). */
	activeKey?: number | null;
	onActivate?: (key: number) => void;
	/** Agenda Outlook affiche a cote : la liste prend toute la hauteur de la fenetre. */
	planning?: boolean;
}) {
	const { muted, card } = styles(nouvelle);
	const ring = nouvelle ? "ring-2 ring-k-accent" : "ring-2 ring-primary";
	// Journee entiere <-> horaire : on garde les jours, 09:00-10:00 par defaut a corriger ; les
	// rappels repartent a ceux par defaut du type (les choix ne sont pas les memes).
	const toggleAllDay = (r: AgendaRow, allDay: boolean) =>
		onChange(
			r.key,
			allDay
				? { allDay, start: datePart(r.start), end: datePart(r.end), reminders: defaultReminders(true), timeToCheck: false }
				: { allDay, start: `${datePart(r.start)}T09:00`, end: `${datePart(r.start)}T10:00`, reminders: defaultReminders(false), timeToCheck: false },
		);
	const setDate = (r: AgendaRow, which: "start" | "end", date: string) =>
		onChange(r.key, { [which]: r.allDay ? date : `${date}T${timePart(r[which]) || "09:00"}` });
	const setTime = (r: AgendaRow, which: "start" | "end", time: string) =>
		onChange(r.key, { [which]: `${datePart(r[which])}T${time}`, timeToCheck: false });

	return (
		<>
			<div className={`text-xs ${muted}`}>
				Propositions à vérifier : rien n'est créé avant votre confirmation. Agenda Outlook de {mailbox}.
				{planning && " Cliquez sur l'agenda pour choisir le créneau de la proposition encadrée."}
			</div>
			<ul className={`${planning ? "min-h-0 flex-1" : "max-h-[60vh]"} space-y-2 overflow-y-auto p-0.5`}>
				{rows.map((r) => (
					<li
						key={r.key}
						className={`${card} space-y-2 ${r.checked ? "" : "opacity-60"} ${onActivate && r.key === activeKey && r.checked ? ring : ""}`}
						onFocusCapture={onActivate ? () => onActivate(r.key) : undefined}
						onMouseDown={onActivate ? () => onActivate(r.key) : undefined}
					>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={r.checked}
								onChange={(e) => onChange(r.key, { checked: e.currentTarget.checked })}
								aria-label="Ajouter cet événement"
							/>
							<TextInput
								className="min-w-0 flex-1"
								size="xs"
								value={r.title}
								onChange={(e) => onChange(r.key, { title: e.currentTarget.value })}
								aria-label="Titre"
							/>
						</div>
						<Checkbox size="xs" label="Journée entière" checked={r.allDay} onChange={(e) => toggleAllDay(r, e.currentTarget.checked)} />
						<div className="flex flex-wrap items-end gap-x-4 gap-y-2">
							{(["start", "end"] as const).map((which) => (
								<div key={which} className="flex items-end gap-1">
									<TextInput
										size="xs"
										type="date"
										label={which === "start" ? "Début" : r.allDay ? "Fin (incluse)" : "Fin"}
										value={datePart(r[which])}
										onChange={(e) => e.currentTarget.value && setDate(r, which, e.currentTarget.value)}
									/>
									{!r.allDay && (
										<TextInput
											size="xs"
											type="time"
											aria-label={which === "start" ? "Heure de début" : "Heure de fin"}
											value={timePart(r[which])}
											onChange={(e) => e.currentTarget.value && setTime(r, which, e.currentTarget.value)}
										/>
									)}
								</div>
							))}
						</div>
						{r.timeToCheck && !r.allDay && (
							<div className="text-xs text-amber-700" role="note">
								Heure à vérifier : le fil n'en donne pas
							</div>
						)}
						<TextInput
							size="xs"
							placeholder="Lieu"
							aria-label="Lieu"
							value={r.location ?? ""}
							onChange={(e) => onChange(r.key, { location: e.currentTarget.value })}
						/>
						{r.sourceQuote && <div className={`text-xs italic ${muted}`}>« {r.sourceQuote} »</div>}
						<RowError error={r.error} />
					</li>
				))}
			</ul>
		</>
	);
}

/** Etape 2 : ce qui sera cree, et le rappel de chaque evenement. */
export function ConfirmStep({
	rows,
	mailbox,
	nouvelle,
	onReminders,
}: {
	rows: AgendaRow[];
	mailbox: string;
	nouvelle: boolean;
	onReminders: (key: number, reminders: number[]) => void;
}) {
	const { muted, card } = styles(nouvelle);
	return (
		<>
			<div className={`text-xs ${muted}`}>
				{rows.length > 1
					? `Ces ${rows.length} événements seront créés dans l'agenda Outlook de ${mailbox}. Les rappels de chacun sont cochés, décochez ceux dont vous n'avez pas besoin.`
					: `Cet événement sera créé dans l'agenda Outlook de ${mailbox}. Ses rappels sont cochés, décochez ceux dont vous n'avez pas besoin.`}
			</div>
			<ul className="max-h-[60vh] space-y-2 overflow-y-auto">
				{rows.map((r) => (
					<li key={r.key} className={`${card} space-y-1`}>
						<div className="text-sm font-medium">{r.title}</div>
						<div className="text-sm">{agendaWhen(r)}</div>
						{r.location && <div className={`text-sm ${muted}`}>Lieu : {r.location}</div>}
						<Reminders row={r} onChange={(reminders) => onReminders(r.key, reminders)} />
						<RowError error={r.error} />
					</li>
				))}
			</ul>
		</>
	);
}

// Horaire : une case par rappel, toutes cochees d'emblee, aucune cochee = aucun rappel.
// Journee entiere : un seul choix.
function Reminders({ row, onChange }: { row: AgendaRow; onChange: (reminders: number[]) => void }) {
	const list = row.reminders ?? defaultReminders(row.allDay);
	if (row.allDay) {
		return (
			<NativeSelect
				size="xs"
				className="max-w-xs pt-1"
				label="Rappel"
				value={String(list[0] ?? "none")}
				onChange={(e) => onChange(e.currentTarget.value === "none" ? [] : [Number(e.currentTarget.value)])}
				data={ALL_DAY_REMINDERS.map((o) => ({ value: String(o.minutes ?? "none"), label: o.label }))}
			/>
		);
	}
	return (
		<Checkbox.Group value={list.map(String)} onChange={(v) => onChange(v.map(Number).sort((a, b) => b - a))} label="Rappels" size="xs" className="pt-1">
			<div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
				{TIMED_REMINDERS.map((o) => (
					<Checkbox key={o.minutes} size="xs" value={String(o.minutes)} label={o.label} />
				))}
			</div>
		</Checkbox.Group>
	);
}
