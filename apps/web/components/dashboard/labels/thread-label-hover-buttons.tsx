"use client";

import { MailboxThreadEntity } from "@db";
import {
	addLabelToThread,
	removeLabelFromThread,
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import { LabelAssignPopover } from "@/components/dashboard/labels/label-assign-popover";
import { useK } from "@/components/k/ui-context";

type ThreadLabelHoverButtonsProps = {
	mailboxThreadItem: MailboxThreadEntity;
	allLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
};

export function ThreadLabelHoverButtons({
	mailboxThreadItem,
	allLabels,
	labelsByThreadId,
}: ThreadLabelHoverButtonsProps) {
	const k = useK();
	const labelThreads = labelsByThreadId[mailboxThreadItem.threadId] || [];
	const selectedLabelIds = labelThreads
		.map((lt) => lt?.label?.id)
		.filter(Boolean) as string[];

	const handleToggle = async (labelId: string, nextChecked: boolean) => {
		if (nextChecked) {
			await addLabelToThread({
				threadId: mailboxThreadItem.threadId,
				mailboxId: mailboxThreadItem.mailboxId,
				labelId,
			});
		} else {
			await removeLabelFromThread({
				threadId: mailboxThreadItem.threadId,
				mailboxId: mailboxThreadItem.mailboxId,
				labelId,
			});
		}
	};

	return (
		<LabelAssignPopover
			title={k("Label message", "Libeller le message")}
			scope="thread"
			allLabels={allLabels}
			selectedLabelIds={selectedLabelIds}
			onToggleLabel={handleToggle}
		/>
	);
}

export default ThreadLabelHoverButtons;
