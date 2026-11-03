import { useDisclosure } from "@mantine/hooks";
import { Modal, Tooltip } from "@mantine/core";
import { Plus } from "lucide-react";
import * as React from "react";
import { ReusableForm } from "@/components/common/reusable-form";
import {
	addNewMailboxFolder,
	FetchIdentityMailboxListResult,
} from "@/lib/actions/mailbox";
import { useMailboxOptions } from "@/hooks/use-mailbox-options";

export default function AddNewFolder({
	mailboxes,
	identity,
}: {
	mailboxes: FetchIdentityMailboxListResult[number]["mailboxes"];
	identity: FetchIdentityMailboxListResult[number]["identity"];
}) {
	const [opened, { open, close }] = useDisclosure(false);

	const { options: mailboxOptions } = useMailboxOptions({
		mailboxes: mailboxes as FetchIdentityMailboxListResult[number]["mailboxes"],
		identityLabel: identity.value,
	});

	const fields = [
		{
			name: "name",
			label: "Nom du dossier",
			wrapperClasses: "col-span-12",
			props: {},
		},
		{
			name: "imapOp",
			wrapperClasses: "hidden",
			props: { hidden: true, defaultValue: identity.smtpAccountId },
		},
		{
			name: "identityId",
			wrapperClasses: "hidden",
			props: { hidden: true, defaultValue: identity.id },
		},
		{
			name: "parentId",
			label: "Placer dans (facultatif)",
			kind: "select" as const,
			options: mailboxOptions,
			wrapperClasses: "col-span-12",
			props: {
				className: "w-full",
				onChange: (val: unknown) => {
									},
			},
		},
	];

	return (
		<>
			<Modal opened={opened} onClose={close} title="Nouveau dossier">
				<ReusableForm
					fields={fields}
					onSuccess={close}
					action={addNewMailboxFolder}
				/>
			</Modal>

			<Tooltip label="Nouveau dossier" openDelay={350} withArrow fz="xs">
				<button
					type="button"
					onClick={open}
					aria-label="Nouveau dossier"
					className="k-focus inline-flex h-5 w-5 items-center justify-center rounded-k-sm text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink"
				>
					<Plus size={14} />
				</button>
			</Tooltip>
		</>
	);
}
