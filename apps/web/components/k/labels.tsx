"use client";

import React from "react";
import { Tree, type RenderTreeNodePayload, useTree } from "@mantine/core";
import {
	IconLabelFilled,
	IconCaretRightFilled,
	IconCaretDownFilled,
} from "@tabler/icons-react";
import AddNewLabel from "@/components/dashboard/labels/add-new-label";
import colors from "tailwindcss/colors";
import { useParams, useRouter } from "next/navigation";
import ManageLabels from "@/components/dashboard/labels/manage-labels";
import { LabelEntity } from "@db";
import { useDynamicContext } from "@/hooks/use-dynamic-context";

type LabelWithCount = LabelEntity & {
	threadCount?: number;
	contactCount?: number;
};

type LabelNode = {
	value: string;
	label: string;
	slug: string;
	count: number;
	colorBg?: string | null;
	children?: LabelNode[];
};

function buildLabelTree(labels: LabelWithCount[]): LabelNode[] {
	const nodeById = new Map<string, LabelNode>();

	for (const l of labels) {
		const count = l.threadCount ?? l.contactCount ?? 0;
		nodeById.set(l.id, {
			value: l.id,
			label: l.name,
			slug: l.slug,
			count,
			colorBg: l.colorBg,
			children: [],
		});
	}

	const roots: LabelNode[] = [];

	for (const l of labels) {
		const node = nodeById.get(l.id)!;

		if (l.parentId && nodeById.has(l.parentId)) {
			const parent = nodeById.get(l.parentId)!;
			parent.children!.push(node);
		} else {
			roots.push(node);
		}
	}

	const pruneEmptyChildren = (nodes: LabelNode[]) => {
		for (const n of nodes) {
			if (n.children && n.children.length === 0) {
				delete n.children;
			} else if (n.children) {
				pruneEmptyChildren(n.children);
			}
		}
	};

	pruneEmptyChildren(roots);
	return roots;
}

// Labels of the modern sidebar.
function KLabels() {
	const { state } = useDynamicContext();
	const labels = (state.labels ?? []) as LabelWithCount[];

	const treeData = buildLabelTree(labels);
	const { identityPublicId, mailboxSlug, labelSlug } = useParams();
	const router = useRouter();

	const selected = React.useMemo(() => {
		const match = labels.find((l) => l.slug === labelSlug);
		return match?.id ?? null;
	}, [labels, labelSlug]);

	const renderNode = ({
		node,
		level,
		expanded,
		hasChildren,
		elementProps,
	}: RenderTreeNodePayload) => {
		const labelNode = node as LabelNode;

		const isSelected = selected === labelNode.value;
		const Icon = IconLabelFilled;
		const color = labelNode.colorBg ?? colors.indigo["500"];
		const routeTo =
			state.scope === "contact"
				? `/w/${state.workspacePublicId}/dashboard/contacts/label/${labelNode.slug}`
				: `/w/${state.workspacePublicId}/dashboard/mail/${identityPublicId}/${mailboxSlug}/label/${labelNode.slug}`;

		return (
			<div
				{...elementProps}
				onClick={(e) => {
					elementProps.onClick?.(e);
					if (selected === labelNode.value) {
						return;
					}
					router.push(routeTo);
				}}
				className={`flex cursor-pointer items-center gap-2.5 rounded-k-sm py-[7px] pr-2.5 text-[13.5px] transition-colors ${
					isSelected ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
				}`}
				style={{ paddingLeft: 10 + (level - 1) * 14 }}
			>
				<span className={hasChildren ? "-ml-3 inline-flex w-3 justify-center" : "hidden"}>
					{hasChildren &&
						(expanded ? (
							<IconCaretDownFilled
								className="text-neutral-500 dark:text-white"
								size={14}
							/>
						) : (
							<IconCaretRightFilled
								className="text-neutral-600 dark:text-white"
								size={14}
							/>
						))}
				</span>

				<span aria-hidden className="mx-[3px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />

				<span className="flex-1 truncate">{labelNode.label}</span>

				<span className="text-[12px] tabular-nums text-k-ink-3">
					{labelNode.count}
				</span>
			</div>
		);
	};

	const tree = useTree();

	return (
		<div className="flex h-full flex-col">
			<div className="mb-1 mt-5 flex items-center justify-between px-2.5">
				<div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">Labels</div>
				<div className="flex items-center gap-1">
					<AddNewLabel globalLabels={labels} />
					<ManageLabels globalLabels={labels} />
				</div>
			</div>

			<div className="pb-4 [&_.mantine-Tree-root]:space-y-px">
				{treeData.length === 0 && <p className="px-2.5 py-1 text-[12.5px] text-k-ink-3">No labels</p>}
				<Tree
					selectOnClick
					tree={tree}
					data={treeData}
					levelOffset={0}
					renderNode={renderNode}
				/>
			</div>
		</div>
	);
}

export default KLabels;
