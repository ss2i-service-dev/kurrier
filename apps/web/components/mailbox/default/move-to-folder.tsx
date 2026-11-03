import React from "react";
import { IconFolderSymlink } from "@tabler/icons-react";
import { Modal, Button, Select } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMailboxOptions } from "@/hooks/use-mailbox-options";
import { useParams } from "next/navigation";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import type { MailboxEntity } from "@db";
import {
	FetchIdentityMailboxListResult,
	moveToFolder,
} from "@/lib/actions/mailbox";
import { toast } from "sonner";
import { moveWithUndo } from "@/lib/pending-moves";
import { useK, useNouvelle } from "@/components/k/ui-context";

function MoveToFolder({
	identityMailboxes,
	activeMailbox,
}: {
	identityMailboxes: FetchIdentityMailboxListResult;
	activeMailbox: MailboxEntity;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const [opened, { open, close }] = useDisclosure(false);
	const params = useParams();

	const entry =
		identityMailboxes.find(
			(im) => im.identity.publicId === params.identityPublicId,
		) ?? null;

	// ss2i : le dossier Drafts est visible dans la barre laterale mais n'est pas une destination.
	const mailboxes = (entry?.mailboxes ?? []).filter((m) => m.kind !== "drafts");
	const { options: mailboxOptions } = useMailboxOptions({
		mailboxes,
		identityLabel: entry?.identity?.value ?? k("Folders", "Dossiers"),
	});

	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
	}>();

	const [destId, setDestId] = React.useState<string | null>(null);
	const [submitting, setSubmitting] = React.useState(false);

	const onConfirm = async () => {
		const active = activeMailbox;
		const ids = Array.from(state?.selectedThreadIds ?? []);
		if (!active?.id || !ids.length || !destId || destId === "none") return;
		if (destId === active.id) {
			toast.info(k("Already in this folder", "Déjà dans ce dossier"));
			return;
		}

		// ss2i : fermeture, retrait de la liste et toast immediats, le serveur suit.
		close();
		setDestId(null);
		setState((prev) => ({ ...prev, selectedThreadIds: new Set() }));
		moveWithUndo({
			mailboxId: active.id,
			threadIds: ids,
			message: ids.length > 1 ? k(`${ids.length} conversations moved`, `${ids.length} conversations déplacées`) : k("Moved to folder", "Déplacée dans le dossier"),
			run: () => moveToFolder(ids, active.id, destId, !!active.metaData?.imap, true),
			failure: k("Move failed, messages restored", "Échec du déplacement, messages restaurés"),
		});
	};

	return (
		<>
			<Modal opened={opened} onClose={close} title={k("Move to", "Déplacer vers")}>
				<div className="space-y-4">
					<Select
						data={mailboxOptions[0]?.items ?? []}
						label={k("Choose folder", "Choisir un dossier")}
						placeholder={k("Select…", "Sélectionner…")}
						value={destId}
						onChange={(v) => setDestId(v)}
						searchable
						nothingFoundMessage={k("No folders", "Aucun dossier")}
					/>
					<div className="flex gap-2 justify-end">
						<Button variant="default" onClick={close} disabled={submitting}>
							{k("Cancel", "Annuler")}
						</Button>
						<Button
							onClick={onConfirm}
							loading={submitting}
							disabled={!destId || destId === "none"}
						>
							{k("Move", "Déplacer")}
						</Button>
					</div>
				</div>
			</Modal>

			<button
				type="button"
				onClick={open}
				className={
					nouvelle
						? "k-focus inline-flex h-8 items-center gap-1.5 rounded-k-sm px-2 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
						: "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
				}
				title={k("Move to folder", "Déplacer vers un dossier")}
				aria-label={k("Move to folder", "Déplacer vers un dossier")}
			>
				<IconFolderSymlink className="h-5 w-5" />
			</button>
		</>
	);
}

export default MoveToFolder;
