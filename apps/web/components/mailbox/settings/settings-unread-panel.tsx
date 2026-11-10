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
import { setListUnderThread } from "@/lib/actions/list-under-thread";
import type { ListUnderThread } from "@/lib/list-under-thread";


// Switch for the side panel of unread threads (per-user option, stored
// server-side).
function SettingsUnreadPanel({
	enabled: initial,
	listPreview,
	threadOrder,
	listUnderThread,
}: {
	enabled: boolean;
	listPreview: ListPreviewMode;
	threadOrder: ThreadOrder;
	listUnderThread: ListUnderThread;
}) {
	const [enabled, setEnabled] = useState(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	const [listHidden, setListHidden] = useState(listUnderThread === "hidden");
	const [listPending, startListTransition] = useTransition();

	// Folder list under the open conversation (classic interface).
	const onListChange = (hidden: boolean) => {
		setListHidden(hidden);
		startListTransition(async () => {
			const r = await setListUnderThread(hidden ? "hidden" : "shown");
			if (r?.success === false) {
				setListHidden(!hidden);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(
				hidden
					? "Folder list hidden under an open conversation."
					: "Folder list shown under an open conversation.",
			);
			router.refresh();
		});
	};

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
				label={"Hide the folder list under an open conversation"}
				description={"Classic interface only. Off by default: the folder list stays under an open conversation. On: the list is hidden while a conversation is open, so the same message does not appear twice."}
				checked={listHidden}
				disabled={listPending}
				onChange={(e) => onListChange(e.currentTarget.checked)}
				mt="md"
			/>
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
