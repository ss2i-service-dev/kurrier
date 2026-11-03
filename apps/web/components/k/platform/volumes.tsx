"use client";
// ss2i : volumes de stockage du Drive (nouvelle interface).
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
			title: "Créer un volume",
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
			Créer un volume
		</Button>
	);
	return (
		<KCard
			flush
			title="Volumes"
			description="Un volume est une racine nommée (dossier local ou bucket) que les membres parcourent dans le Drive."
			actions={volumes.length ? addBtn : undefined}
		>
			{volumes.length === 0 ? (
				<KEmpty
					icon={<HardDrive />}
					title="Aucun volume"
					text="Créez votre premier volume pour stocker les fichiers de l'espace de travail."
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
										? ` · créé le ${new Date(v.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`
										: ""}
								</>
							}
							badges={
								<KBadge tone={verified ? "ok" : "warn"} icon={verified ? <BadgeCheck /> : <Clock />}>
									{verified ? "Fournisseur vérifié" : "Fournisseur non vérifié"}
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
									Ouvrir
								</Button>
							}
						/>
					);
				})
			)}
		</KCard>
	);
}
