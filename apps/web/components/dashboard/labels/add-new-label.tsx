"use client";

import { useDisclosure } from "@mantine/hooks";
import { Modal, ActionIcon, ColorPicker } from "@mantine/core";
import * as React from "react";
import { ReusableForm } from "@/components/common/reusable-form";
import { IconPlus } from "@tabler/icons-react";
import { addNewLabel, FetchLabelsResult } from "@/lib/actions/labels";
import ReusableFormCustomWrapper from "@/components/common/reusable-form-custom-wrapper";
import { DEFAULT_COLORS_SWATCH } from "@common/mail-client";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import {useParams} from "next/navigation";
import { useK, useNouvelle } from "@/components/k/ui-context";

function useLabelOptions({ labels }: { labels: any[] }) {
	const options = labels.map((l) => ({
		label: l.name,
		value: l.id,
	}));

	return { options };
}

export default function AddNewLabel({
	globalLabels,
}: {
	globalLabels: FetchLabelsResult;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const [opened, { open, close }] = useDisclosure(false);

	const { options: labelOptions } = useLabelOptions({ labels: globalLabels });
	const { state } = useDynamicContext();
	const { identityPublicId } = useParams();

	const fields = [
		{
			name: "name",
			label: k("Label Name", "Nom du libellé"),
			wrapperClasses: "col-span-12",
			props: {
				placeholder: k("e.g., Work, Finance, Travel...", "ex. : Travail, Finance, Voyages…"),
			},
		},
		{
			name: "parentId",
			label: k("Nest Label Under (Optional)", "Placer dans (facultatif)"),
			kind: "select" as const,
			options: labelOptions,
			wrapperClasses: "col-span-12",
			props: {
				className: "w-full",
			},
		},
		{
			name: "scope",
			type: "hidden",
			wrapperClasses: "hidden",
			props: { hidden: true, defaultValue: state.scope },
		},
		{
			name: "color",
			wrapperClasses: "col-span-12 flex justify-center my-3",
			kind: "custom" as const,
			component: ReusableFormCustomWrapper,
			props: {
				size: "sm",
				format: "hex",
				swatches: DEFAULT_COLORS_SWATCH,
				component: ColorPicker,
				defaultValue: "#228be6",
			},
		},
	];

	if (state.scope === "thread") {
		fields.push({
			name: "identityPublicId",
			type: "hidden",
			wrapperClasses: "hidden",
			props: { hidden: true, defaultValue: identityPublicId },
		});
	}

	return (
		<>
			<Modal opened={opened} onClose={close} title={k("New Label", "Nouveau libellé")} size="sm">
				<ReusableForm
					fields={fields}
					onSuccess={close}
					action={addNewLabel}
					submitButtonProps={{
						submitLabel: k("Create label", "Créer le libellé"),
						wrapperClasses: "flex justify-center my-4",
					}}
				/>
			</Modal>

			{nouvelle ? (
				<button
					type="button"
					onClick={open}
					title="Nouveau libellé"
					aria-label="Nouveau libellé"
					className="k-focus inline-flex h-5 w-5 items-center justify-center rounded-k-sm text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink"
				>
					<IconPlus size={14} />
				</button>
			) : (
				<ActionIcon variant="light" size="xs" onClick={open}>
					<IconPlus size={12} />
				</ActionIcon>
			)}
		</>
	);
}
