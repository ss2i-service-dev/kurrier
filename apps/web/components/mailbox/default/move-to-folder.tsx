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
import { useModernUi } from "@/components/k/ui-context";

function MoveToFolder({
	identityMailboxes,
	activeMailbox,
}: {
	identityMailboxes: FetchIdentityMailboxListResult;
	activeMailbox: MailboxEntity;
}) {
	const modern = useModernUi();
	const [opened, { open, close }] = useDisclosure(false);
	const params = useParams();

	const entry =
		identityMailboxes.find(
			(im) => im.identity.publicId === params.identityPublicId,
		) ?? null;

	// The Drafts folder is visible in the sidebar but is not a destination.
	const mailboxes = (entry?.mailboxes ?? []).filter((m) => m.kind !== "drafts");
	const { options: mailboxOptions } = useMailboxOptions({
		mailboxes,
		identityLabel: entry?.identity?.value ?? "Folders",
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
			toast.info("Already in this folder");
			return;
		}

		// Close, remove from the list and toast immediately, the server follows.
		close();
		setDestId(null);
		setState((prev) => ({ ...prev, selectedThreadIds: new Set() }));
		moveWithUndo({
			mailboxId: active.id,
			threadIds: ids,
			message: ids.length > 1 ? `${ids.length} conversations moved` : "Moved to folder",
			run: () => moveToFolder(ids, active.id, destId, !!active.metaData?.imap, true),
			failure: "Move failed, messages restored",
		});
	};

	return (
		<>
			<Modal opened={opened} onClose={close} title={"Move to"}>
				<div className="space-y-4">
					<Select
						data={mailboxOptions[0]?.items ?? []}
						label={"Choose folder"}
						placeholder={"Select…"}
						value={destId}
						onChange={(v) => setDestId(v)}
						searchable
						nothingFoundMessage={"No folders"}
					/>
					<div className="flex gap-2 justify-end">
						<Button variant="default" onClick={close} disabled={submitting}>
							{"Cancel"}
						</Button>
						<Button
							onClick={onConfirm}
							loading={submitting}
							disabled={!destId || destId === "none"}
						>
							{"Move"}
						</Button>
					</div>
				</div>
			</Modal>

			<button
				type="button"
				onClick={open}
				className={
					modern
						? "k-focus inline-flex h-8 items-center gap-1.5 rounded-k-sm px-2 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
						: "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted"
				}
				title={"Move to folder"}
				aria-label={"Move to folder"}
			>
				<IconFolderSymlink className="h-5 w-5" />
			</button>
		</>
	);
}

export default MoveToFolder;
