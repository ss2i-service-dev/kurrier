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
import { setStripSubjectPrefixesEnabled } from "@/lib/actions/subject-prefixes";
import { setHour24Enabled } from "@/lib/actions/hour-format";
import type { ListUnderThread } from "@/lib/list-under-thread";


// Switch for the side panel of unread threads (per-user option, stored
// server-side).
function SettingsUnreadPanel({
	enabled: initial,
	listPreview,
	threadOrder,
	listUnderThread,
	stripPrefixes: initialStrip = false,
	hour24: initialHour24 = false,
}: {
	enabled: boolean;
	listPreview: ListPreviewMode;
	threadOrder: ThreadOrder;
	listUnderThread: ListUnderThread;
	stripPrefixes?: boolean;
	hour24?: boolean;
}) {
	const [enabled, setEnabled] = useState(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	const [listHidden, setListHidden] = useState(listUnderThread === "hidden");
	const [listPending, startListTransition] = useTransition();
	const [strip, setStrip] = useState(initialStrip);
	const [stripPending, startStripTransition] = useTransition();
	const [hour24, setHour24] = useState(initialHour24);
	const [hour24Pending, startHour24Transition] = useTransition();

	// Times of the invitation cards in 24-hour format.
	const onHour24Change = (next: boolean) => {
		setHour24(next);
		startHour24Transition(async () => {
			const r = await setHour24Enabled(next);
			if (r?.success === false) {
				setHour24(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(next ? "Times are shown in 24-hour format." : "Times follow the format of your language.");
			router.refresh();
		});
	};

	// Subject without Re:/Fwd: (lists, threads, replies and forwards).
	const onStripChange = (next: boolean) => {
		setStrip(next);
		startStripTransition(async () => {
			const r = await setStripSubjectPrefixesEnabled(next);
			if (r?.success === false) {
				setStrip(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(
				next
					? "Subjects are shown and sent without Re:/Fwd:."
					: "Subjects are shown and sent as received.",
			);
			router.refresh();
		});
	};

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
				label={"Subjects without Re: and Fwd:"}
				description={"Off by default: subjects are shown as received, and replies and forwards start with Re: or Fwd:. On: the prefixes stacked by mail clients (RE: TR: Fwd: AW:) are hidden in the lists, the search and the conversations, and a reply or a forward is sent with the plain subject. The conversation holds through the message headers, not the subject."}
				checked={strip}
				disabled={stripPending}
				onChange={(e) => onStripChange(e.currentTarget.checked)}
				mt="md"
			/>
			<Switch
				label={"Times in 24-hour format"}
				description={"Off by default: the times of an invitation follow the format of your browser language (12 h with AM/PM for most English locales). On: 13:30 instead of 1:30 PM."}
				checked={hour24}
				disabled={hour24Pending}
				onChange={(e) => onHour24Change(e.currentTarget.checked)}
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
