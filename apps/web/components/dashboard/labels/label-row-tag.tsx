import React from "react";
import { Badge } from "@mantine/core";
import { useParams } from "next/navigation";
import { useNouvelle } from "@/components/k/ui-context";
import { frLabelName } from "@/components/k/fr-messages";
import { FetchMailboxThreadLabelsResult } from "@/lib/actions/labels";

type LabelRowTagProps = {
	threadId: string;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	isRead: boolean;
};

function LabelRowTag({ threadId, labelsByThreadId, isRead }: LabelRowTagProps) {
	const labelThreads = labelsByThreadId[threadId] ?? [];

	const nouvelle = useNouvelle();
	const { labelSlug } = useParams<{ labelSlug?: string }>();
	const slug =
		typeof labelSlug === "string" ? labelSlug.toLowerCase() : undefined;

	const visibleLabels = labelThreads.filter((item) => {
		const label = item.label;
		if (!label) return false;
		if (!slug) return true;
		return label.slug?.toLowerCase() !== slug;
	});

	return visibleLabels.map((item) => {
		const label = item.label!;

		return (
			<Badge
				key={label.id}
				size="xs"
				className="min-w-fit"
				opacity={isRead ? 0.75 : 1}
				color={label.colorBg ?? undefined}
				radius="md"
				variant="filled"
			>
				{frLabelName(label.name, nouvelle)}
			</Badge>
		);
	});
}

export default LabelRowTag;
