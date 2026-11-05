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


// Switch for the side panel of unread threads (per-user option, stored
// server-side).
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

	const onChange = (next: boolean) => {
		setEnabled(next);
		startTransition(async () => {
			const r = await setUnreadPanelEnabled(next);
			if (r?.success === false) {
				setEnabled(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(
				next
					? "Unread messages panel enabled."
					: "Unread messages panel disabled.",
			);
			router.refresh();
		});
	};

	return (
		<SectionCard
			title={"Reading"}
			description={"How conversations and the message list are displayed."}
		>
			<SettingsListPreview mode={listPreview} />
			<SettingsThreadOrder order={threadOrder} />
			<Switch
				label={"Unread messages panel"}
				description={"Show a side panel listing the unread conversations of the current folder next to the open conversation (wide screens only)."}
				checked={enabled}
				disabled={pending}
				onChange={(e) => onChange(e.currentTarget.checked)}
				mt="md"
			/>
		</SectionCard>
	);
}

export default SettingsUnreadPanel;
