"use client";
import { useState, useTransition } from "react";
import { SegmentedControl, Text } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	setListPreviewMode,
	type ListPreviewMode,
} from "@/lib/actions/list-preview";


// Content of the rows in the thread list (per-user option, stored server-side).
// Rendered inside the "Reading" card.
function SettingsListPreview({ mode: initial }: { mode: ListPreviewMode }) {
	const [mode, setMode] = useState<ListPreviewMode>(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();

	const onChange = (value: string) => {
		const next: ListPreviewMode =
			value === "subject" ? "subject" : "subject_snippet";
		const previous = mode;
		setMode(next);
		startTransition(async () => {
			const r = await setListPreviewMode(next);
			if (r?.success === false) {
				setMode(previous);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(
				next === "subject"
					? "Message list shows the subject only."
					: "Message list shows the subject and a preview.",
			);
			router.refresh();
		});
	};

	return (
		<div>
			<Text size="sm" fw={500}>
				{"Message list preview"}
			</Text>
			<Text size="xs" c="dimmed" mb={6}>
				{"What each row of the message list shows. With the subject only, the subject gets the whole row width."}
			</Text>
			<SegmentedControl
				value={mode}
				disabled={pending}
				onChange={onChange}
				data={[
					{ value: "subject", label: "Subject only" },
					{ value: "subject_snippet", label: "Subject and preview" },
				]}
			/>
		</div>
	);
}

export default SettingsListPreview;
