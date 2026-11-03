"use client";
import React, { useState, useTransition } from "react";
import { Switch } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setUnreadPanelEnabled } from "@/lib/actions/unread-panel";
import SettingsListPreview from "@/components/mailbox/settings/settings-list-preview";
import type { ListPreviewMode } from "@/lib/actions/list-preview";
import SettingsThreadOrder from "@/components/mailbox/settings/settings-thread-order";
import type { ThreadOrder } from "@/lib/actions/thread-order";
import { useK } from "@/components/k/ui-context";

// ss2i : interrupteur du panneau lateral des fils non lus (option par
// utilisateur, memorisee cote serveur).
function SettingsUnreadPanel({
	enabled: initial,
	listPreview,
	threadOrder,
}: {
	enabled: boolean;
	listPreview: ListPreviewMode;
	threadOrder: ThreadOrder;
}) {
	const [enabled, setEnabled] = useState(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	const k = useK();

	const onChange = (next: boolean) => {
		setEnabled(next);
		startTransition(async () => {
			const r = await setUnreadPanelEnabled(next);
			if (r?.success === false) {
				setEnabled(!next);
				toast.error(r.error ?? k("Could not save the preference", "Impossible d'enregistrer la préférence"));
				return;
			}
			toast.success(
				next
					? k("Unread messages panel enabled.", "Panneau des non lus activé.")
					: k("Unread messages panel disabled.", "Panneau des non lus désactivé."),
			);
			router.refresh();
		});
	};

	return (
		<SectionCard
			title={k("Reading", "Lecture")}
			description={k("How conversations and the message list are displayed.", "Affichage des conversations et de la liste des messages.")}
		>
			<SettingsListPreview mode={listPreview} />
			<SettingsThreadOrder order={threadOrder} />
			<Switch
				label={k("Unread messages panel", "Panneau des messages non lus")}
				description={k(
					"Show a side panel listing the unread conversations of the current folder next to the open conversation (wide screens only).",
					"Affiche à côté de la conversation ouverte un panneau listant les conversations non lues du dossier courant (grands écrans uniquement).",
				)}
				checked={enabled}
				disabled={pending}
				onChange={(e) => onChange(e.currentTarget.checked)}
				mt="md"
			/>
		</SectionCard>
	);
}

export default SettingsUnreadPanel;
