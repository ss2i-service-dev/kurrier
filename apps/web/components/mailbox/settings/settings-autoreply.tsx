"use client";
import React, { useActionState, useEffect, useState } from "react";
import Form from "next/form";
import { Button, Switch, TextInput, Textarea } from "@mantine/core";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import type { FormState } from "@schema";
import type { VacationResponse } from "@/lib/actions/vacation";


type SaveAction = (_prev: FormState, formData: FormData) => Promise<FormState>;

// ISO UTC -> "datetime-local" value in the browser time zone.
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
		if (formState.error) toast.error("Error", { description: formState.error });
		else if (formState.success) toast.success(formState.message ?? "Saved");
	}, [formState]);

	if (error) {
		return (
			<SectionCard title="Auto-reply" description="Automatic reply handled by the mail server.">
				<div className="text-sm text-red-600">{error}</div>
			</SectionCard>
		);
	}

	return (
		<SectionCard
			title="Auto-reply"
			description="Handled by the mail server itself: it answers whatever client you use. Each sender gets the reply once."
		>
			<Form action={formAction} className="space-y-4">
				<input type="hidden" name="identityPublicId" value={identityPublicId} />
				<input type="hidden" name="pathname" value={pathname} />
				<input type="hidden" name="tzOffset" value={tzOffset} />
				<Switch
					name="isEnabled"
					label="Auto-reply enabled"
					checked={enabled}
					onChange={(e) => setEnabled(e.currentTarget.checked)}
				/>
				<TextInput
					name="subject"
					label="Subject"
					placeholder="Out of office"
					defaultValue={vacation?.subject ?? ""}
				/>
				<Textarea
					name="textBody"
					label="Message"
					autosize
					minRows={5}
					maxRows={16}
					defaultValue={vacation?.textBody ?? ""}
				/>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<TextInput
						type="datetime-local"
						name="fromDate"
						label="Start (optional)"
						value={fromDate}
						onChange={(e) => setFromDate(e.currentTarget.value)}
					/>
					<TextInput
						type="datetime-local"
						name="toDate"
						label="End (optional)"
						value={toDate}
						onChange={(e) => setToDate(e.currentTarget.value)}
					/>
				</div>
				<div className="flex items-center justify-end">
					<Button type="submit" loading={isPending}>
						Save auto-reply
					</Button>
				</div>
			</Form>
		</SectionCard>
	);
}
