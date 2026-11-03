"use client";
import React, { useState, useTransition } from "react";
import { SegmentedControl } from "@mantine/core";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setInterfaceMode, type InterfaceMode } from "@/lib/actions/interface-pref";
import { useK } from "@/components/k/ui-context";

// ss2i : choix de l'interface de la messagerie (option par utilisateur).
// Classique par defaut ; la nouvelle interface est en essai.
function SettingsInterface({ mode: initial }: { mode: InterfaceMode }) {
	const [mode, setMode] = useState<InterfaceMode>(initial);
	const [pending, startTransition] = useTransition();
	// texte dans la langue de l'interface en cours (anglais dans Gmail, comme le reste de l'ecran)
	const t = useK();

	const onChange = (value: string) => {
		const next: InterfaceMode = value === "nouvelle" ? "nouvelle" : "classic";
		const previous = mode;
		setMode(next);
		startTransition(async () => {
			const r = await setInterfaceMode(next);
			if (r?.success === false) {
				setMode(previous);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			// Rechargement complet : la page change de structure et de theme.
			window.location.reload();
		});
	};

	return (
		<SectionCard
			title="Interface"
			description={t(
				"Mail interface for your account. Other users are not affected.",
				"Interface de la messagerie pour votre compte. Les autres utilisateurs ne sont pas concernés.",
			)}
		>
			<SegmentedControl
				value={mode}
				disabled={pending}
				onChange={onChange}
				data={[
					{ value: "classic", label: "Gmail" },
					{ value: "nouvelle", label: "Outlook" },
				]}
			/>
		</SectionCard>
	);
}

export default SettingsInterface;
