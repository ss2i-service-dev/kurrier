"use client";
import React, { useActionState, useEffect, useState } from "react";
import Form from "next/form";
import { Button, Switch, TextInput, Textarea } from "@mantine/core";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import type { FormState } from "@schema";
import type { VacationResponse } from "@/lib/actions/vacation";
import { useK } from "@/components/k/ui-context";

type SaveAction = (_prev: FormState, formData: FormData) => Promise<FormState>;

// ISO UTC -> valeur « datetime-local » dans le fuseau du navigateur.
function toLocalInput(iso: string | null) {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SettingsAutoReply({
	identityPublicId,
	vacation,
	error,
	save,
}: {
	identityPublicId: string;
	vacation: VacationResponse | null;
	error: string | null;
	save: SaveAction;
}) {
	const pathname = usePathname();
	const k = useK();
	const [enabled, setEnabled] = useState(Boolean(vacation?.isEnabled));
	const [fromDate, setFromDate] = useState("");
	const [toDate, setToDate] = useState("");
	const [tzOffset, setTzOffset] = useState(0);
	useEffect(() => {
		setFromDate(toLocalInput(vacation?.fromDate ?? null));
		setToDate(toLocalInput(vacation?.toDate ?? null));
		setTzOffset(new Date().getTimezoneOffset());
	}, [vacation?.fromDate, vacation?.toDate]);

	const [formState, formAction, isPending] = useActionState<FormState, FormData>(save, {});
	useEffect(() => {
		if (formState.error) toast.error(k("Error", "Erreur"), { description: formState.error });
		else if (formState.success) toast.success(formState.message ?? k("Saved", "Enregistré"));
	}, [formState]);

	if (error) {
		return (
			<SectionCard title={k("Auto-reply", "Réponse automatique")} description={k("Automatic reply handled by the mail server.", "Réponse automatique gérée par le serveur de messagerie.")}>
				<div className="text-sm text-red-600">{error}</div>
			</SectionCard>
		);
	}

	return (
		<SectionCard
			title={k("Auto-reply", "Réponse automatique")}
			description={k(
				"Handled by the mail server itself: it answers whatever client you use. Each sender gets the reply once.",
				"Gérée par le serveur de messagerie lui-même : elle répond quel que soit le client utilisé. Chaque expéditeur ne reçoit la réponse qu'une fois.",
			)}
		>
			<Form action={formAction} className="space-y-4">
				<input type="hidden" name="identityPublicId" value={identityPublicId} />
				<input type="hidden" name="pathname" value={pathname} />
				<input type="hidden" name="tzOffset" value={tzOffset} />
				<Switch
					name="isEnabled"
					label={k("Auto-reply enabled", "Réponse automatique activée")}
					checked={enabled}
					onChange={(e) => setEnabled(e.currentTarget.checked)}
				/>
				<TextInput
					name="subject"
					label={k("Subject", "Objet")}
					placeholder={k("Out of office", "Absent du bureau")}
					defaultValue={vacation?.subject ?? ""}
				/>
				<Textarea
					name="textBody"
					label={k("Message", "Message")}
					autosize
					minRows={5}
					maxRows={16}
					defaultValue={vacation?.textBody ?? ""}
				/>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<TextInput
						type="datetime-local"
						name="fromDate"
						label={k("Start (optional)", "Début (facultatif)")}
						value={fromDate}
						onChange={(e) => setFromDate(e.currentTarget.value)}
					/>
					<TextInput
						type="datetime-local"
						name="toDate"
						label={k("End (optional)", "Fin (facultatif)")}
						value={toDate}
						onChange={(e) => setToDate(e.currentTarget.value)}
					/>
				</div>
				<div className="flex items-center justify-end">
					<Button type="submit" loading={isPending}>
						{k("Save auto-reply", "Enregistrer la réponse automatique")}
					</Button>
				</div>
			</Form>
		</SectionCard>
	);
}
