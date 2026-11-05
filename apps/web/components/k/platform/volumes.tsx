"use client";
// Drive storage volumes (modern interface).
import * as React from "react";
import Link from "next/link";
import { Button } from "@mantine/core";
import { modals } from "@mantine/modals";
import { BadgeCheck, Clock, Database, HardDrive, Plus } from "lucide-react";
import { DriveVolumeEntity } from "@db";
import type { SyncProvidersRow } from "@/lib/actions/dashboard";
import AddVolumeForm from "@/components/dashboard/storage/add-volume-form";
import { KBadge, KCard, KEmpty, KRow } from "@/components/k/platform/ui";

export default function KVolumes({
	userProviders,
	volumes,
	workspacePublicId,
	provisioned,
	providerSelectOptions,
}: {
	userProviders: SyncProvidersRow[];
	volumes: DriveVolumeEntity[];
	workspacePublicId: string;
	provisioned: boolean;
	providerSelectOptions: { label: string; value: string }[];
}) {
	const openAdd = () => {
		const id = modals.open({
			title: "Create a volume",
			closeOnEscape: false,
			closeOnClickOutside: false,
			size: "lg",
			children: (
				<div className="pb-2 pt-1">
					<AddVolumeForm
						userProviders={userProviders}
						providerSelectOptions={providerSelectOptions}
						onCompleted={() => modals.close(id)}
					/>
				</div>
			),
		});
	};
	const addBtn = (
		<Button size="xs" onClick={openAdd} leftSection={<Plus size={14} />}>
			Create a volume
		</Button>
	);
	return (
		<KCard
			flush
			title="Volumes"
			description="A volume is a named root (local folder or bucket) that members browse in the Drive."
			actions={volumes.length ? addBtn : undefined}
		>
			{volumes.length === 0 ? (
				<KEmpty
					icon={<HardDrive />}
					title="No volumes"
					text="Create your first volume to store the workspace files."
					action={addBtn}
				/>
			) : (
				volumes.map((v) => {
					const provider = userProviders.find((p) => p.id === v.providerId);
					const verification = provider?.metaData?.verification;
					const providerType = provider?.type ?? "local";
					const verified = provisioned || v.kind === "local" ? true : !!verification?.store;
					return (
						<KRow
							key={v.id}
							icon={<HardDrive />}
							title={v.label}
							meta={
								<>
									{providerType.toUpperCase()}
									{v.createdAt
										? ` · created ${new Date(v.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`
										: ""}
								</>
							}
							badges={
								<KBadge tone={verified ? "ok" : "warn"} icon={verified ? <BadgeCheck /> : <Clock />}>
									{verified ? "Provider verified" : "Provider not verified"}
								</KBadge>
							}
							actions={
								<Button
									component={Link}
									href={`/w/${workspacePublicId}/dashboard/drive/volumes/${v.publicId}`}
									variant="default"
									size="xs"
									leftSection={<Database size={14} />}
								>
									Open
								</Button>
							}
						/>
					);
				})
			)}
		</KCard>
	);
}
