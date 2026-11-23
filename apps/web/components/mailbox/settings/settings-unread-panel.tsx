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
import { setAutoReloadEnabled } from "@/lib/actions/auto-reload";
import { setShowDraftsCountEnabled } from "@/lib/actions/drafts-count";
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
	autoReload: initialAutoReload = false,
	showDraftsCount: initialShowDraftsCount = false,
}: {
	enabled: boolean;
	listPreview: ListPreviewMode;
	threadOrder: ThreadOrder;
	listUnderThread: ListUnderThread;
	stripPrefixes?: boolean;
	hour24?: boolean;
	autoReload?: boolean;
	showDraftsCount?: boolean;
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
	const [autoReload, setAutoReload] = useState(initialAutoReload);
	const [autoReloadPending, startAutoReloadTransition] = useTransition();
	const [showDraftsCount, setShowDraftsCount] = useState(initialShowDraftsCount);
	const [showDraftsCountPending, startShowDraftsCountTransition] = useTransition();

	// Number of drafts next to Drafts in the sidebars.
	const onShowDraftsCountChange = (next: boolean) => {
		setShowDraftsCount(next);
		startShowDraftsCountTransition(async () => {
			const r = await setShowDraftsCountEnabled(next);
			if (r?.success === false) {
				setShowDraftsCount(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(next ? "Drafts shows its number of drafts." : "Drafts is shown without a number.");
			router.refresh();
		});
	};

	// Page reloaded by itself after an update of Kurrier.
	const onAutoReloadChange = (next: boolean) => {
		setAutoReload(next);
		startAutoReloadTransition(async () => {
			const r = await setAutoReloadEnabled(next);
			if (r?.success === false) {
				setAutoReload(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(next ? "The page reloads itself after an update." : "The page is no longer reloaded after an update.");
			router.refresh();
		});
	};

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
				label={"Reload the page after an update"}
				description={"Off by default. A tab opened before an update keeps the old version and can fail with \"An unexpected response was received from the server\". On: when a new version is deployed (checked when you come back to the tab and every 30 seconds), or as soon as a server action fails because of it, the page is covered by a notice that blocks the screen and reloads. Drafts in progress are kept in this browser and reopened after the reload."}
				checked={autoReload}
				disabled={autoReloadPending}
				onChange={(e) => onAutoReloadChange(e.currentTarget.checked)}
				mt="md"
			/>
			<Switch
				label={"Number of drafts"}
				description={"Off by default: Drafts is shown without a number. On: the sidebar shows how many drafts are waiting next to Drafts, in both interfaces (drafts waiting to be sent are not counted)."}
				checked={showDraftsCount}
				disabled={showDraftsCountPending}
				onChange={(e) => onShowDraftsCountChange(e.currentTarget.checked)}
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
