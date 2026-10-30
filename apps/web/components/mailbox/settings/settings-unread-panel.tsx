"use client";
import React, { useState, useTransition } from "react";
import { Switch } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setUnreadPanelEnabled } from "@/lib/actions/unread-panel";

// ss2i : interrupteur du panneau lateral des fils non lus (option par
// utilisateur, memorisee cote serveur).
function SettingsUnreadPanel({ enabled: initial }: { enabled: boolean }) {
	const [enabled, setEnabled] = useState(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();

	const onChange = (next: boolean) => {
		setEnabled(next);
		startTransition(async () => {
			const r = await setUnreadPanelEnabled(next);
			if (r?.success === false) {
				setEnabled(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(next ? "Unread messages panel enabled." : "Unread messages panel disabled.");
			router.refresh();
		});
	};

	return (
		<SectionCard title="Reading" description="How an open conversation is displayed.">
			<Switch
				label="Unread messages panel"
				description="Show a side panel listing the unread conversations of the current folder next to the open conversation (wide screens only)."
				checked={enabled}
				disabled={pending}
				onChange={(e) => onChange(e.currentTarget.checked)}
			/>
		</SectionCard>
	);
}

export default SettingsUnreadPanel;
