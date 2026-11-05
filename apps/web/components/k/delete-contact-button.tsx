"use client";
// Contact deletion with a confirmation dialog. Same server action as the classic interface.
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
			title: <span className="font-semibold">Delete contact</span>,
			centered: true,
			children: (
				<div className="text-sm">
					Are you sure you want to delete{" "}
					<b>{[contact.firstName, contact.lastName].filter(Boolean).join(" ")}</b>? This action cannot be undone.
				</div>
			),
			labels: { confirm: "Delete", cancel: "Cancel" },
			confirmProps: { color: "red" },
			onConfirm: async () => {
				await onDeleteAction(contact.id);
				router.push(`/w/${workspacePublicId}/dashboard/contacts`);
			},
		});
	};
	return (
		<KIconButton label="Delete" tone="danger" onClick={confirmDelete}>
			<Trash2 />
		</KIconButton>
	);
}
