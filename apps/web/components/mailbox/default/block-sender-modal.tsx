"use client";

import React, { useEffect, useState } from "react";
import { Button, Checkbox, Modal, Text } from "@mantine/core";
import { toast } from "sonner";
import { usePathname } from "next/navigation";
import { blockSender, countExistingFromSender } from "@/lib/actions/sender-blocks";
import type { BlockKind } from "@common/sender-block";

// ss2i : confirmation du blocage d'une adresse ou d'un domaine (menu de l'en-tete d'un mail,
// proposition apres une desinscription). La case « Also move existing mails » est cochee par
// defaut ; le worker traite les mails deja presents par lots.
export default function BlockSenderModal({
	kind,
	value,
	opened,
	onClose,
}: {
	kind: BlockKind;
	value: string;
	opened: boolean;
	onClose: () => void;
}) {
	const pathname = usePathname();
	const [trashExisting, setTrashExisting] = useState(true);
	const [count, setCount] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!opened) return;
		setTrashExisting(true);
		setCount(null);
		countExistingFromSender(kind, value)
			.then(setCount)
			.catch(() => setCount(null));
	}, [opened, kind, value]);

	const confirm = async () => {
		setBusy(true);
		try {
			const res = await blockSender({ kind, value, trashExisting, pathname });
			if (!res.success) {
				toast.error(res.error ?? "Block failed", { position: "bottom-left" });
				return;
			}
			const moved = res.data?.moved ?? 0;
			toast.success(
				trashExisting
					? `Blocked ${value}: ${moved} mail${moved === 1 ? "" : "s"} moved to Trash`
					: `Blocked ${value}`,
				{ position: "bottom-left" },
			);
			onClose();
		} catch (e: any) {
			toast.error(e?.message ?? "Block failed", { position: "bottom-left" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={kind === "domain" ? `Block domain ${value}` : `Block ${value}`}
			centered
		>
			<Text size="sm" mb="md">
				{kind === "domain"
					? `New mails from ${value} and its subdomains go straight to Trash, on all your identities, with no notification.`
					: `New mails from ${value} go straight to Trash, on all your identities, with no notification.`}
			</Text>
			<Checkbox
				checked={trashExisting}
				onChange={(e) => setTrashExisting(e.currentTarget.checked)}
				label={`Also move existing mails from ${value} to Trash${
					count === null ? "" : ` (${count} in your Inbox)`
				}`}
			/>
			<div className="mt-5 flex justify-end gap-2">
				<Button variant="default" onClick={onClose} disabled={busy}>
					Cancel
				</Button>
				<Button color="red" onClick={confirm} loading={busy}>
					Block
				</Button>
			</div>
		</Modal>
	);
}
