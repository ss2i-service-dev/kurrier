"use client";
import React from "react";
import { Checkbox, NativeSelect, TextInput } from "@mantine/core";
import { type AgendaEvent, type AgendaReminder, agendaWhen, remindersFor } from "@common/thread-agenda";

// ss2i : les deux etapes de « Ajouter a l'agenda » (OI 10280), sans etat ni appel serveur :
// propositions a corriger, puis recapitulatif de ce qui sera cree avec le rappel de chaque
// evenement (« Aucun rappel » par defaut). Libelles en francais dans les deux interfaces.

export type AgendaRow = AgendaEvent & { key: number; checked: boolean; error?: string };

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
}: {
	rows: AgendaRow[];
	mailbox: string;
	nouvelle: boolean;
	onChange: (key: number, patch: Partial<AgendaRow>) => void;
}) {
	const { muted, card } = styles(nouvelle);
	// Journee entiere <-> horaire : on garde les jours, 09:00-10:00 par defaut a corriger ; le
	// rappel repart a « aucun » (les choix ne sont pas les memes).
	const toggleAllDay = (r: AgendaRow, allDay: boolean) =>
		onChange(
			r.key,
			allDay
				? { allDay, start: datePart(r.start), end: datePart(r.end), reminder: "none" }
				: { allDay, start: `${datePart(r.start)}T09:00`, end: `${datePart(r.start)}T10:00`, reminder: "none" },
		);
	const setDate = (r: AgendaRow, which: "start" | "end", date: string) =>
		onChange(r.key, { [which]: r.allDay ? date : `${date}T${timePart(r[which]) || "09:00"}` });
	const setTime = (r: AgendaRow, which: "start" | "end", time: string) =>
		onChange(r.key, { [which]: `${datePart(r[which])}T${time}` });

	return (
		<>
			<div className={`text-xs ${muted}`}>
				Propositions à vérifier : rien n'est créé avant votre confirmation. Agenda Outlook de {mailbox}.
			</div>
			<ul className="max-h-[60vh] space-y-2 overflow-y-auto">
				{rows.map((r) => (
					<li key={r.key} className={`${card} space-y-2 ${r.checked ? "" : "opacity-60"}`}>
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
	onReminder,
}: {
	rows: AgendaRow[];
	mailbox: string;
	nouvelle: boolean;
	onReminder: (key: number, reminder: AgendaReminder) => void;
}) {
	const { muted, card } = styles(nouvelle);
	return (
		<>
			<div className={`text-xs ${muted}`}>
				{rows.length > 1
					? `Ces ${rows.length} événements seront créés dans l'agenda Outlook de ${mailbox}. Choisissez un rappel pour chacun.`
					: `Cet événement sera créé dans l'agenda Outlook de ${mailbox}. Choisissez son rappel.`}
			</div>
			<ul className="max-h-[60vh] space-y-2 overflow-y-auto">
				{rows.map((r) => (
					<li key={r.key} className={`${card} space-y-1`}>
						<div className="text-sm font-medium">{r.title}</div>
						<div className="text-sm">{agendaWhen(r)}</div>
						{r.location && <div className={`text-sm ${muted}`}>Lieu : {r.location}</div>}
						<NativeSelect
							size="xs"
							className="max-w-xs pt-1"
							label="Rappel"
							value={r.reminder ?? "none"}
							onChange={(e) => onReminder(r.key, e.currentTarget.value as AgendaReminder)}
							data={remindersFor(r.allDay).map((o) => ({ value: o.value, label: o.label }))}
						/>
						<RowError error={r.error} />
					</li>
				))}
			</ul>
		</>
	);
}
