"use client";

import React, { useMemo, useState } from "react";
import {
	Popover,
	TextInput,
	ScrollArea,
	Checkbox,
	Button,
	ActionIcon,
	Tooltip,
} from "@mantine/core";
import { IconLabel, IconLabelFilled } from "@tabler/icons-react";
import { LabelEntity } from "@db";
import type { LabelScope } from "@schema";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { frLabelName } from "@/components/k/fr-messages";

type LabelAssignPopoverProps = {
	title: string;
	scope: LabelScope;
	allLabels: LabelEntity[];
	selectedLabelIds: string[];
	onToggleLabel: (
		labelId: string,
		nextChecked: boolean,
	) => Promise<void> | void;
};

export function LabelAssignPopover({
	title,
	scope,
	allLabels,
	selectedLabelIds,
	onToggleLabel,
}: LabelAssignPopoverProps) {
	const k = useK();
	const nouvelle = useNouvelle();
	const [opened, setOpened] = useState(false);
	const [query, setQuery] = useState("");

	const labelSet = new Set(selectedLabelIds);

	const filteredLabels = useMemo(() => {
		const q = query.trim().toLowerCase();
		const scoped = allLabels.filter(
			(l) => l.scope === scope || l.scope === "all",
		);
		if (!q) return scoped;
		return scoped.filter((l) => l.name.toLowerCase().includes(q));
	}, [allLabels, query, scope]);

	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			withinPortal
			position="bottom-end"
			withArrow
			offset={12}
			arrowPosition="side"
			arrowSize={20}
			arrowOffset={24}
			trapFocus
			shadow="xl"
			radius="md"
		>
			<Popover.Target>
				<Tooltip label={k("Add or remove labels", "Ajouter ou retirer des libellés")} withArrow>
					<ActionIcon
						onClick={(e) => {
							e.stopPropagation();
							setOpened((v) => !v);
						}}
						variant={"transparent"}
						aria-label={k("Add or remove labels", "Ajouter ou retirer des libellés")}
						className={nouvelle ? "!text-k-ink-2 hover:!text-k-ink" : undefined}
					>
						<IconLabel size={22} stroke={1.5} className={"mt-1"} />
					</ActionIcon>
				</Tooltip>
			</Popover.Target>

			<Popover.Dropdown
				className={
					nouvelle
						? "w-72 rounded-k border border-k-line bg-k-surface p-3 shadow-k-pop"
						: "w-72 bg-popover border border-border rounded-xl p-3 shadow-lg"
				}
			>
				<div className="flex flex-col gap-2">
					<div className={`px-0.5 text-xs font-semibold ${nouvelle ? "text-k-ink-3" : "text-muted-foreground"}`}>
						{title}
					</div>

					<TextInput
						size="xs"
						radius="md"
						placeholder={k("Search labels…", "Rechercher un libellé…")}
						aria-label={k("Search labels", "Rechercher un libellé")}
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
					/>

					<ScrollArea.Autosize mah={220} className="mt-1.5">
						{filteredLabels.length === 0 ? (
							<div className={`px-1.5 py-2 text-xs ${nouvelle ? "text-k-ink-3" : "text-muted-foreground"}`}>
								{k("No labels found", "Aucun libellé trouvé")}
							</div>
						) : (
							<div className="flex flex-col gap-0.5">
								{filteredLabels.map((label) => {
									const checked = labelSet.has(label.id);

									return (
										<button
											key={label.id}
											type="button"
											onClick={async (e) => {
												e.stopPropagation();
												await onToggleLabel(label.id, !checked);
											}}
											className={[
												"flex w-full items-center gap-2 px-2 py-1.5 text-left",
												nouvelle ? "rounded-k-sm text-k-ink hover:bg-k-hover" : "rounded-md hover:bg-muted",
												checked ? (nouvelle ? "bg-k-selected" : "bg-muted/70") : "",
											].join(" ")}
										>
											<IconLabelFilled
												size={24}
												style={{ color: label.colorBg || "#64748b" }}
												className="-ml-2"
											/>
											<span className="truncate text-xs">{frLabelName(label.name, nouvelle)}</span>
											<span className="ml-auto">
												<Checkbox
													size="xs"
													checked={checked}
													readOnly
													className="pointer-events-none"
												/>
											</span>
										</button>
									);
								})}
							</div>
						)}
					</ScrollArea.Autosize>
				</div>
			</Popover.Dropdown>
		</Popover>
	);
}
