"use client";
import { useState, useTransition } from "react";
import { SegmentedControl, Text } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	setListPreviewMode,
	type ListPreviewMode,
} from "@/lib/actions/list-preview";
import { useK } from "@/components/k/ui-context";

// ss2i : contenu des lignes de la liste des fils (option par utilisateur,
// memorisee cote serveur). Rendu a l'interieur de la carte « Reading ».
function SettingsListPreview({ mode: initial }: { mode: ListPreviewMode }) {
	const [mode, setMode] = useState<ListPreviewMode>(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	const k = useK();

	const onChange = (value: string) => {
		const next: ListPreviewMode =
			value === "subject" ? "subject" : "subject_snippet";
		const previous = mode;
		setMode(next);
		startTransition(async () => {
			const r = await setListPreviewMode(next);
			if (r?.success === false) {
				setMode(previous);
				toast.error(r.error ?? k("Could not save the preference", "Impossible d'enregistrer la préférence"));
				return;
			}
			toast.success(
				next === "subject"
					? k("Message list shows the subject only.", "La liste affiche l'objet seul.")
					: k("Message list shows the subject and a preview.", "La liste affiche l'objet et un aperçu."),
			);
			router.refresh();
		});
	};

	return (
		<div>
			<Text size="sm" fw={500}>
				{k("Message list preview", "Aperçu dans la liste des messages")}
			</Text>
			<Text size="xs" c="dimmed" mb={6}>
				{k(
					"What each row of the message list shows. With the subject only, the subject gets the whole row width.",
					"Ce que montre chaque ligne de la liste. Avec l'objet seul, l'objet occupe toute la largeur de la ligne.",
				)}
			</Text>
			<SegmentedControl
				value={mode}
				disabled={pending}
				onChange={onChange}
				data={[
					{ value: "subject", label: k("Subject only", "Objet seul") },
					{ value: "subject_snippet", label: k("Subject and preview", "Objet et aperçu") },
				]}
			/>
		</div>
	);
}

export default SettingsListPreview;
