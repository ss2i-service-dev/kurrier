"use client";
// ss2i : suppression d'un contact (confirmation en francais). Meme action serveur que la classique.
import React from "react";
import { Trash2 } from "lucide-react";
import { modals } from "@mantine/modals";
import { useRouter } from "next/navigation";
import { ContactEntity } from "@db";
import KIconButton from "@/components/k/icon-button";

export default function KDeleteContactButton({
	contact,
	workspacePublicId,
	onDeleteAction,
}: {
	contact: ContactEntity;
	workspacePublicId: string;
	onDeleteAction: (id: string) => Promise<{ success: boolean }>;
}) {
	const router = useRouter();
	const confirmDelete = () => {
		if (!contact.id) return;
		modals.openConfirmModal({
			title: <span className="font-semibold">Supprimer le contact</span>,
			centered: true,
			children: (
				<div className="text-sm">
					Voulez-vous vraiment supprimer{" "}
					<b>{[contact.firstName, contact.lastName].filter(Boolean).join(" ")}</b> ? Cette action est définitive.
				</div>
			),
			labels: { confirm: "Supprimer", cancel: "Annuler" },
			confirmProps: { color: "red" },
			onConfirm: async () => {
				await onDeleteAction(contact.id);
				router.push(`/w/${workspacePublicId}/dashboard/contacts`);
			},
		});
	};
	return (
		<KIconButton label="Supprimer" tone="danger" onClick={confirmDelete}>
			<Trash2 />
		</KIconButton>
	);
}
