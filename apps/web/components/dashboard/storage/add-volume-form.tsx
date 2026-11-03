import { addNewVolume, type SyncProvidersRow } from "@/lib/actions/dashboard";
import { ReusableForm } from "@/components/common/reusable-form";
import React from "react";
import { FieldConfig } from "@schema";
import { Select } from "@mantine/core";
import { useNouvelle } from "@/components/k/ui-context";

function AddVolumeForm({
	providerSelectOptions,
	onCompleted,
}: {
	userProviders: SyncProvidersRow[];
	providerSelectOptions: { label: string; value: string }[];
	onCompleted?: () => void;
}) {
	// ss2i : textes francais dans la nouvelle interface
	const nv = useNouvelle();
	const fields: FieldConfig[] = [
		// {
		// 	name: "provider",
		// 	label: "Choose a verified provider",
		// 	kind: "custom",
		// 	component: Select,
		// 	wrapperClasses: "col-span-12",
		// 	props: {
		// 		defaultValue: providerSelectOptions[0]?.value || null,
		// 		className: "w-full",
		// 		required: true,
		// 		data: providerSelectOptions,
		// 		allowDeselect: false,
		// 	},
		// },
		{
			name: "bucketName",
			label: nv ? "Nom du bucket" : "Bucket Name",
			wrapperClasses: "col-span-12",
			bottomStartPrefix: (
				<span className={"text-xs"}>
					{nv
						? "Kurrier créera ce bucket chez votre fournisseur de stockage."
						: "Kurrier will create this bucket in your storage provider."}
				</span>
			),
			props: {
				autoComplete: "off",
				required: true,
			},
		},
	];

	const finalizeVolume = async () => {
		if (onCompleted) onCompleted();
	};

	return (
		<div>
			<ReusableForm
				action={addNewVolume}
				onSuccess={finalizeVolume}
				fields={fields}
				submitButtonProps={{
					submitLabel: nv ? "Créer le bucket" : "Create Bucket",
					wrapperClasses: "justify-center mt-6 flex",
					buttonProps: {
						fullWidth: true,
					},
				}}
			/>
		</div>
	);
}

export default AddVolumeForm;
